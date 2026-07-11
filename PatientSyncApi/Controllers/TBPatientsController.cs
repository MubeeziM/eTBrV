using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Handles Unit TB Register data sync requests from the PWA.
///
/// SECURITY:
///   - Connection string is read from server-side config only; never returned to clients.
///   - All SQL uses parameterised queries — no string concatenation (OWASP A03:2021).
///   - Exception details are logged server-side only; clients receive generic messages.
///   - [Authorize] on data-write endpoints ensures only authenticated users can sync.
///   - DataSourceID, CountyID, and EnteredByID are stamped server-side from JWT claims
///     so a client cannot falsely claim to belong to a different facility.
/// </summary>
[ApiController]
[Route("api/tb-patients")]
[Authorize]
public sealed class TBPatientsController : ControllerBase
{
    private readonly string _connectionString;
    private readonly ILogger<TBPatientsController> _logger;

    public TBPatientsController(IConfiguration config, ILogger<TBPatientsController> logger)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  POST /api/tb-patients/sync-full
    //  Accepts a TBFullSyncPayload (patients + follow-ups) from the PWA and
    //  performs a MERGE upsert on PtDetailsT and DELETE/INSERT on PtFollowUpT.
    // ───────────────────────────────────────────────────────────────────────
    [HttpPost("sync-full")]
    public async Task<IActionResult> SyncFull([FromBody] TBFullSyncPayload? payload)
    {
        if (payload is null || payload.Patients.Count == 0)
            return BadRequest(new { error = "No patient records provided." });

        if (payload.Patients.Count > 500)
            return BadRequest(new { error = "Batch size exceeds the maximum of 500 records." });

        // ── Extract facility scope from JWT claims ────────────────────────
        var userTIDStr  = User.FindFirstValue(ClaimTypes.NameIdentifier)
                       ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                       ?? string.Empty;
        var facilityStr = User.FindFirstValue("facility_id") ?? "0";
        var countyStr   = User.FindFirstValue("county_id")   ?? "0";

        int.TryParse(facilityStr, out var dataSourceID);
        if (dataSourceID < 0)
            return BadRequest(new { error = "Invalid facility claim in token. Please log in again." });

        int.TryParse(countyStr, out var countyID);

        Guid enteredByID = Guid.TryParse(userTIDStr, out var parsedGuid)
            ? parsedGuid
            : Guid.Empty;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();

            // ── MERGE PtDetailsT ──────────────────────────────────────────
            const string mergeSql = """
                MERGE INTO PtDetailsT AS target
                USING (
                    SELECT @PtDetailsTID AS PtDetailsTID,
                           COALESCE(NULLIF(hf.CountyID, 0), NULLIF(@CountyID, 0), 0) AS ResolvedCountyID,
                           COALESCE(ds.DataSourceID, 0)                               AS ResolvedDataSourceID
                    FROM   (VALUES(1)) AS v(n)
                    LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID = @NearestHFID
                    LEFT JOIN DataSourceT     ds ON ds.DataSourceID      = @NearestHFID
                ) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    Deleted=@Deleted,
                    NearestHFID=@NearestHFID,
                    CountyID=source.ResolvedCountyID,
                    RegDate=@RegDate, UnitTBNo=@UnitTBNo, PtName=@PtName,
                    DateOfBirth=@DateOfBirth, Age=@Age, AgeMonths=@AgeMonths, SexID=@SexID,
                    ReferredByID=@ReferredByID,
                    Village=@Village, Boma=@Boma, Payam=@Payam, County=@County, PtPhone=@PtPhone,
                    TbTypeID=@TbTypeID, PtTypeID=@PtTypeID, TIHF=@TIHF, TICounty=@TICounty,
                    DateRxStarted=@DateRxStarted, RegimenID=@RegimenID, DiagMethodID=@DiagMethodID
                WHEN NOT MATCHED BY TARGET THEN
                  INSERT (
                    PtDetailsTID, NearestHFID, DataSourceID, CountyID, EnteredByID,
                    HasChanged, CreatedOn, LastModOn,
                    Deleted, RegDate, UnitTBNo, PtName,
                    DateOfBirth, Age, AgeMonths, SexID, ReferredByID,
                    Village, Boma, Payam, County, PtPhone,
                    TbTypeID, PtTypeID, TIHF, TICounty,
                    DateRxStarted, RegimenID, DiagMethodID, CountryID
                  ) VALUES (
                    @PtDetailsTID, @NearestHFID, source.ResolvedDataSourceID, source.ResolvedCountyID, @EnteredByID,
                    0, GETDATE(), GETDATE(),
                    @Deleted, @RegDate, @UnitTBNo, @PtName,
                    @DateOfBirth, @Age, @AgeMonths, @SexID, @ReferredByID,
                    @Village, @Boma, @Payam, @County, @PtPhone,
                    @TbTypeID, @PtTypeID, @TIHF, @TICounty,
                    @DateRxStarted, @RegimenID, @DiagMethodID, @CountryID
                  );
                """;

            foreach (var p in payload.Patients)
            {
                await using var cmd = new SqlCommand(mergeSql, conn, tx);
                cmd.Parameters.AddWithValue("@PtDetailsTID",   p.PtDetailsTID);
                cmd.Parameters.AddWithValue("@NearestHFID",    p.NearestHFID);
                cmd.Parameters.AddWithValue("@CountyID",       countyID);
                cmd.Parameters.AddWithValue("@EnteredByID",    enteredByID);
                cmd.Parameters.AddWithValue("@Deleted",        p.Deleted);
                cmd.Parameters.AddWithValue("@RegDate",        (object?)p.RegDate          ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@UnitTBNo",       (object?)p.UnitTBNo         ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@PtName",         p.PtName);
                cmd.Parameters.AddWithValue("@DateOfBirth",    (object?)p.DateOfBirth       ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Age",            p.Age);
                cmd.Parameters.AddWithValue("@AgeMonths",      (object?)p.AgeMonths         ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@SexID",          p.SexID);
                cmd.Parameters.AddWithValue("@ReferredByID",   p.ReferredByID);
                cmd.Parameters.AddWithValue("@Village",        (object?)p.Village           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Boma",           (object?)p.Boma              ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Payam",          (object?)p.Payam             ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@County",         (object?)p.County            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@PtPhone",        (object?)p.PtPhone           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@TbTypeID",       p.TbTypeID);
                cmd.Parameters.AddWithValue("@PtTypeID",       p.PtTypeID);
                cmd.Parameters.AddWithValue("@TIHF",           (object?)p.TIHF              ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@TICounty",       (object?)p.TICounty          ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@DateRxStarted",  (object?)p.DateRxStarted     ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@RegimenID",      p.RegimenID);
                cmd.Parameters.AddWithValue("@DiagMethodID",   p.DiagMethodID);
                cmd.Parameters.AddWithValue("@CountryID",      p.CountryID);
                await cmd.ExecuteNonQueryAsync();
            }

            // ── Collect synced patient TIDs ────────────────────────────────
            // ── MERGE PtFollowUpT ─────────────────────────────────────────
            // Keyed on PtFollowUpTID — UPDATE if the row exists, INSERT if not.
            // This is safe at any scale and never leaves ghost rows behind.
            const string mergeFUSql = """
                MERGE INTO PtFollowUpT AS target
                USING (SELECT @PtFollowUpTID AS PtFollowUpTID) AS source
                ON target.PtFollowUpTID = source.PtFollowUpTID
                WHEN MATCHED THEN UPDATE SET
                    PtDetailsTID=@PtDetailsTID, HasChanged=0, Deleted=@Deleted, LastModOn=GETDATE(), EnteredByID=@EnteredByID,
                    Mon0Date=@Mon0Date, Mon0LabNo=@Mon0LabNo, Mon0LabResultID=@Mon0LabResultID,
                    Mon0XpertResultID=@Mon0XpertResultID, Mon0XpertResultDate=@Mon0XpertResultDate,
                    HIVTestDate=@HIVTestDate, HIVTestResultID=@HIVTestResultID, DSTResult=@DSTResult,
                    Mon2Date=@Mon2Date, Mon2LabNo=@Mon2LabNo, Mon2LabResultID=@Mon2LabResultID,
                    Mon3Date=@Mon3Date, Mon3LabNo=@Mon3LabNo, Mon3LabResultID=@Mon3LabResultID,
                    Mon5Date=@Mon5Date, Mon5LabNo=@Mon5LabNo, Mon5LabResultID=@Mon5LabResultID,
                    Mon6Date=@Mon6Date, Mon6LabNo=@Mon6LabNo, Mon6LabResultID=@Mon6LabResultID,
                    OutcomeID=@OutcomeID, OutcomeDate=@OutcomeDate, TOHF=@TOHF, TOCounty=@TOCounty,
                    OnART=@OnART, ARTDate=@ARTDate, OnCPT=@OnCPT, CPTDate=@CPTDate,
                    MovedTo2ndLine=@MovedTo2ndLine, Remarks=@Remarks
                WHEN NOT MATCHED BY TARGET THEN INSERT (
                    PtFollowUpTID, PtDetailsTID, HasChanged, Deleted, LastModOn, CreatedOn, EnteredByID,
                    Mon0Date, Mon0LabNo, Mon0LabResultID, Mon0XpertResultID, Mon0XpertResultDate,
                    HIVTestDate, HIVTestResultID, DSTResult,
                    Mon2Date, Mon2LabNo, Mon2LabResultID,
                    Mon3Date, Mon3LabNo, Mon3LabResultID,
                    Mon5Date, Mon5LabNo, Mon5LabResultID,
                    Mon6Date, Mon6LabNo, Mon6LabResultID,
                    OutcomeID, OutcomeDate, TOHF, TOCounty,
                    OnART, ARTDate, OnCPT, CPTDate,
                    MovedTo2ndLine, Remarks
                ) VALUES (
                    @PtFollowUpTID, @PtDetailsTID, 0, @Deleted, GETDATE(), GETDATE(), @EnteredByID,
                    @Mon0Date, @Mon0LabNo, @Mon0LabResultID, @Mon0XpertResultID, @Mon0XpertResultDate,
                    @HIVTestDate, @HIVTestResultID, @DSTResult,
                    @Mon2Date, @Mon2LabNo, @Mon2LabResultID,
                    @Mon3Date, @Mon3LabNo, @Mon3LabResultID,
                    @Mon5Date, @Mon5LabNo, @Mon5LabResultID,
                    @Mon6Date, @Mon6LabNo, @Mon6LabResultID,
                    @OutcomeID, @OutcomeDate, @TOHF, @TOCounty,
                    @OnART, @ARTDate, @OnCPT, @CPTDate,
                    @MovedTo2ndLine, @Remarks
                );
                """;

            foreach (var fu in payload.FollowUps)
            {
                await using var cmd = new SqlCommand(mergeFUSql, conn, tx);
                cmd.Parameters.AddWithValue("@PtFollowUpTID",       fu.PtFollowUpTID);
                cmd.Parameters.AddWithValue("@PtDetailsTID",        fu.PtDetailsTID);
                cmd.Parameters.AddWithValue("@Deleted",             fu.Deleted);
                cmd.Parameters.AddWithValue("@EnteredByID",         enteredByID);
                cmd.Parameters.AddWithValue("@Mon0Date",            (object?)fu.Mon0Date            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon0LabNo",           (object?)fu.Mon0LabNo           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon0LabResultID",     fu.Mon0LabResultID);
                cmd.Parameters.AddWithValue("@Mon0XpertResultID",   fu.Mon0XpertResultID);
                cmd.Parameters.AddWithValue("@Mon0XpertResultDate", (object?)fu.Mon0XpertResultDate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@HIVTestDate",         (object?)fu.HIVTestDate         ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@HIVTestResultID",     fu.HIVTestResultID);
                cmd.Parameters.AddWithValue("@DSTResult",           (object?)fu.DSTResult           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon2Date",            (object?)fu.Mon2Date            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon2LabNo",           (object?)fu.Mon2LabNo           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon2LabResultID",     fu.Mon2LabResultID);
                cmd.Parameters.AddWithValue("@Mon3Date",            (object?)fu.Mon3Date            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon3LabNo",           (object?)fu.Mon3LabNo           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon3LabResultID",     fu.Mon3LabResultID);
                cmd.Parameters.AddWithValue("@Mon5Date",            (object?)fu.Mon5Date            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon5LabNo",           (object?)fu.Mon5LabNo           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon5LabResultID",     fu.Mon5LabResultID);
                cmd.Parameters.AddWithValue("@Mon6Date",            (object?)fu.Mon6Date            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon6LabNo",           (object?)fu.Mon6LabNo           ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Mon6LabResultID",     fu.Mon6LabResultID);
                cmd.Parameters.AddWithValue("@OutcomeID",           fu.OutcomeID);
                cmd.Parameters.AddWithValue("@OutcomeDate",         (object?)fu.OutcomeDate         ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@TOHF",                (object?)fu.TOHF                ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@TOCounty",            (object?)fu.TOCounty            ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@OnART",               fu.OnART);
                cmd.Parameters.AddWithValue("@ARTDate",             (object?)fu.ARTDate             ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@OnCPT",               fu.OnCPT);
                cmd.Parameters.AddWithValue("@CPTDate",             (object?)fu.CPTDate             ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@MovedTo2ndLine",      fu.MovedTo2ndLine);
                cmd.Parameters.AddWithValue("@Remarks",             (object?)fu.Remarks             ?? DBNull.Value);
                await cmd.ExecuteNonQueryAsync();
            }

            await tx.CommitAsync();

            _logger.LogInformation(
                "TB sync-full: {PtCount} patient(s), {FuCount} follow-up(s) by user {User}",
                payload.Patients.Count, payload.FollowUps.Count, enteredByID);

            return Ok(new
            {
                message   = $"Synced {payload.Patients.Count} TB patient(s) and {payload.FollowUps.Count} follow-up record(s).",
                patients  = payload.Patients.Count,
                followUps = payload.FollowUps.Count
            });
        }
        catch (SqlException ex)
        {
            _logger.LogError(ex, "TB sync-full SQL error (user {User})", enteredByID);
            return StatusCode(500, new { error = "Database error during TB sync.", sqlErrorNumber = ex.Number, sqlErrorMessage = ex.Message });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TB sync-full unexpected error (user {User})", enteredByID);
            return StatusCode(500, new { error = "An unexpected error occurred during TB sync." });
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/mine
    //  Returns all TB patient records (+ follow-ups) entered by the
    //  authenticated user.  Used on login to pull records from other devices.
    //  INSERT OR IGNORE on the client means existing local edits are safe.
    //
    //  Query parameters:
    //    since       — ISO-8601 timestamp; when set, only returns records
    //                  modified after this time (delta pull).
    //    regDateFrom — YYYY-MM-DD date; when set, only returns patients whose
    //                  registration date (RegDate) is on or after this date.
    //                  The PWA sets this to 18 months ago so that read-heavy
    //                  sessions (data entrants) don't download decades of data.
    // ───────────────────────────────────────────────────────────────────────
    [HttpGet("mine")]
    public async Task<IActionResult> GetMine([FromQuery] DateTime? since = null, [FromQuery] DateTime? regDateFrom = null)
    {
        var userTIDStr = User.FindFirstValue(ClaimTypes.NameIdentifier)
                      ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                      ?? string.Empty;

        if (!Guid.TryParse(userTIDStr, out var enteredByID) || enteredByID == Guid.Empty)
            return BadRequest(new { error = "Invalid user identity in token." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            bool isDelta         = since.HasValue;
            var sinceClause      = isDelta            ? "AND LastModOn > @Since"      : "";
            var regDateFromClause = regDateFrom.HasValue ? "AND RegDate >= @RegDateFrom" : "";

            var patSql = $"""
                SELECT
                    CAST(PtDetailsTID AS nvarchar(36)) AS PtDetailsTID,
                    HasChanged, Deleted, NearestHFID, DataSourceID, CountyID,
                    CAST(EnteredByID AS nvarchar(36))          AS EnteredByID,
                    CONVERT(nvarchar(30), LastModOn, 126)      AS LastModOn,
                    CONVERT(nvarchar(30), CreatedOn,  126)     AS CreatedOn,
                    CONVERT(nvarchar(10), RegDate,         23) AS RegDate,
                    UnitTBNo, PtName,
                    CONVERT(nvarchar(10), DateOfBirth,     23) AS DateOfBirth,
                    Age, AgeMonths, SexID, ReferredByID,
                    Village, Boma, Payam, County, PtPhone,
                    TbTypeID, PtTypeID, TIHF, TICounty,
                    CONVERT(nvarchar(10), DateRxStarted,   23) AS DateRxStarted,
                    RegimenID, DiagMethodID, CountryID
                FROM PtDetailsT
                WHERE EnteredByID = @EnteredByID
                {sinceClause}
                {regDateFromClause}
                ORDER BY LastModOn DESC
                """;

            await using var patCmd = new SqlCommand(patSql, conn);
            patCmd.Parameters.AddWithValue("@EnteredByID", enteredByID);
            if (isDelta)           patCmd.Parameters.AddWithValue("@Since",        since!.Value);
            if (regDateFrom.HasValue) patCmd.Parameters.AddWithValue("@RegDateFrom", regDateFrom.Value.Date);

            var patients = new List<Dictionary<string, object?>>();
            await using (var rdr = await patCmd.ExecuteReaderAsync())
            {
                while (await rdr.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < rdr.FieldCount; i++)
                        row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                    patients.Add(row);
                }
            }

            if (!isDelta && patients.Count == 0)
                return Ok(new { patients = patients, followUps = Array.Empty<object>() });

            // ── Follow-ups scoped to those patients ───────────────────────
            // ── Follow-ups ──────────────────────────────────────────────────────────────
            // Delta: filter by timestamp. Full: scope by parent TID set via OPENJSON.
            List<Dictionary<string, object?>> followUps;
            if (isDelta)
            {
                const string fuDeltaSql = """
                    SELECT
                        CAST(PtFollowUpTID AS nvarchar(36)) AS PtFollowUpTID,
                        CAST(PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                        HasChanged, Deleted,
                        CAST(EnteredByID AS nvarchar(36))           AS EnteredByID,
                        CONVERT(nvarchar(30), LastModOn, 126)       AS LastModOn,
                        CONVERT(nvarchar(30), CreatedOn,  126)      AS CreatedOn,
                        CONVERT(nvarchar(10), Mon0Date,          23) AS Mon0Date,
                        Mon0LabNo, Mon0LabResultID,
                        CONVERT(nvarchar(10), Mon0XpertResultDate, 23) AS Mon0XpertResultDate,
                        Mon0XpertResultID,
                        CONVERT(nvarchar(10), HIVTestDate,       23) AS HIVTestDate,
                        HIVTestResultID, DSTResult,
                        CONVERT(nvarchar(10), Mon2Date,          23) AS Mon2Date,
                        Mon2LabNo, Mon2LabResultID,
                        CONVERT(nvarchar(10), Mon3Date,          23) AS Mon3Date,
                        Mon3LabNo, Mon3LabResultID,
                        CONVERT(nvarchar(10), Mon5Date,          23) AS Mon5Date,
                        Mon5LabNo, Mon5LabResultID,
                        CONVERT(nvarchar(10), Mon6Date,          23) AS Mon6Date,
                        Mon6LabNo, Mon6LabResultID,
                        OutcomeID,
                        CONVERT(nvarchar(10), OutcomeDate,       23) AS OutcomeDate,
                        TOHF, TOCounty, OnART,
                        CONVERT(nvarchar(10), ARTDate,           23) AS ARTDate,
                        OnCPT,
                        CONVERT(nvarchar(10), CPTDate,           23) AS CPTDate,
                        MovedTo2ndLine, Remarks
                    FROM PtFollowUpT
                    WHERE EnteredByID = @EnteredByID AND LastModOn > @Since
                    """;
                await using var fuCmd = new SqlCommand(fuDeltaSql, conn);
                fuCmd.Parameters.AddWithValue("@EnteredByID", enteredByID);
                fuCmd.Parameters.AddWithValue("@Since", since!.Value);
                followUps = new List<Dictionary<string, object?>>();
                await using (var rdr = await fuCmd.ExecuteReaderAsync())
                {
                    while (await rdr.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>();
                        for (int i = 0; i < rdr.FieldCount; i++)
                            row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                        followUps.Add(row);
                    }
                }
            }
            else
            {
                // Full pull: follow-ups scoped to parent TIDs via OPENJSON.
                var tidsList = patients
                    .Select(p => p["PtDetailsTID"]?.ToString())
                    .Where(t => !string.IsNullOrEmpty(t))
                    .ToList();
                var tidsJson = System.Text.Json.JsonSerializer.Serialize(tidsList);
                const string fuSql = """
                    SELECT
                        CAST(PtFollowUpTID AS nvarchar(36)) AS PtFollowUpTID,
                        CAST(PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                        HasChanged, Deleted,
                        CAST(EnteredByID AS nvarchar(36))           AS EnteredByID,
                        CONVERT(nvarchar(30), LastModOn, 126)       AS LastModOn,
                        CONVERT(nvarchar(30), CreatedOn,  126)      AS CreatedOn,
                        CONVERT(nvarchar(10), Mon0Date,          23) AS Mon0Date,
                        Mon0LabNo, Mon0LabResultID,
                        CONVERT(nvarchar(10), Mon0XpertResultDate, 23) AS Mon0XpertResultDate,
                        Mon0XpertResultID,
                        CONVERT(nvarchar(10), HIVTestDate,       23) AS HIVTestDate,
                        HIVTestResultID, DSTResult,
                        CONVERT(nvarchar(10), Mon2Date,          23) AS Mon2Date,
                        Mon2LabNo, Mon2LabResultID,
                        CONVERT(nvarchar(10), Mon3Date,          23) AS Mon3Date,
                        Mon3LabNo, Mon3LabResultID,
                        CONVERT(nvarchar(10), Mon5Date,          23) AS Mon5Date,
                        Mon5LabNo, Mon5LabResultID,
                        CONVERT(nvarchar(10), Mon6Date,          23) AS Mon6Date,
                        Mon6LabNo, Mon6LabResultID,
                        OutcomeID,
                        CONVERT(nvarchar(10), OutcomeDate,       23) AS OutcomeDate,
                        TOHF, TOCounty, OnART,
                        CONVERT(nvarchar(10), ARTDate,           23) AS ARTDate,
                        OnCPT,
                        CONVERT(nvarchar(10), CPTDate,           23) AS CPTDate,
                        MovedTo2ndLine, Remarks
                    FROM PtFollowUpT
                    WHERE CAST(PtDetailsTID AS nvarchar(36)) IN
                          (SELECT value FROM OPENJSON(@TIDsJson))
                    """;
                await using var fuCmd = new SqlCommand(fuSql, conn);
                fuCmd.Parameters.AddWithValue("@TIDsJson", tidsJson);
                followUps = new List<Dictionary<string, object?>>();
                await using (var rdr = await fuCmd.ExecuteReaderAsync())
                {
                    while (await rdr.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>();
                        for (int i = 0; i < rdr.FieldCount; i++)
                            row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                        followUps.Add(row);
                    }
                }
            }

            _logger.LogInformation(
                "TB GetMine: {P} patients, {F} follow-ups for {UserTID}.",
                patients.Count, followUps.Count, enteredByID);

            return Ok(new { patients, followUps });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in TB GetMine for {UserTID}.", enteredByID);
            return StatusCode(500, new { error = "Could not retrieve your TB patient records." });
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  POST /api/tb-patients/sync-presumptive
    //  Upserts monthly presumptive case tallies.
    // ───────────────────────────────────────────────────────────────────────
    [HttpPost("sync-presumptive")]
    public async Task<IActionResult> SyncPresumptive([FromBody] TBPresumptiveSyncPayload? payload)
    {
        if (payload is null || payload.Cases.Count == 0)
            return BadRequest(new { error = "No presumptive case records provided." });

        var userTIDStr = User.FindFirstValue(ClaimTypes.NameIdentifier)
                      ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                      ?? string.Empty;
        Guid enteredByID = Guid.TryParse(userTIDStr, out var g) ? g : Guid.Empty;

        var facilityStr = User.FindFirstValue("facility_id") ?? "0";
        int.TryParse(facilityStr, out var dataSourceID);

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();

            const string mergeSql = """
                MERGE INTO PresumptiveCaseT AS target
                ON (target.NearestHFID = @NearestHFID
                    AND target.MonthID  = @MonthID
                    AND target.YearID   = @YearID)
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    PresumptiveCase=@PresumptiveCase,
                    DataSourceID=@DataSourceID
                WHEN NOT MATCHED BY TARGET THEN
                  INSERT (PresumptiveCaseTID, PresumptiveCase, MonthID, YearID,
                          NearestHFID, DataSourceID, CountyID,
                          HasChanged, Uploaded, Imported, LastModOn, EnteredByID)
                  VALUES (@PresumptiveCaseTID, @PresumptiveCase, @MonthID, @YearID,
                          @NearestHFID, @DataSourceID,
                          COALESCE(NULLIF((SELECT TOP 1 CountyID FROM HealthFacilityT WHERE HealthFacilityID = @NearestHFID), 0), 0),
                          0, 0, 0, GETDATE(), @EnteredByID);
                """;

            foreach (var c in payload.Cases)
            {
                await using var cmd = new SqlCommand(mergeSql, conn, tx);
                cmd.Parameters.AddWithValue("@PresumptiveCaseTID", c.PresumptiveCaseTID);
                cmd.Parameters.AddWithValue("@PresumptiveCase",    c.PresumptiveCase);
                cmd.Parameters.AddWithValue("@MonthID",            c.MonthID);
                cmd.Parameters.AddWithValue("@YearID",             c.YearID);
                cmd.Parameters.AddWithValue("@NearestHFID",        c.NearestHFID);
                cmd.Parameters.AddWithValue("@DataSourceID",       dataSourceID);
                cmd.Parameters.AddWithValue("@EnteredByID",        enteredByID);
                await cmd.ExecuteNonQueryAsync();
            }

            await tx.CommitAsync();

            return Ok(new { message = $"Synced {payload.Cases.Count} presumptive case record(s).", count = payload.Cases.Count });
        }
        catch (SqlException ex)
        {
            _logger.LogError(ex, "TB sync-presumptive SQL error (user {User})", enteredByID);
            return StatusCode(500, new { error = "Database error during presumptive case sync.", sqlErrorNumber = ex.Number });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TB sync-presumptive unexpected error (user {User})", enteredByID);
            return StatusCode(500, new { error = "An unexpected error occurred." });
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/dq-counts
    //  Returns the 8 pre-report DQ issue counts for the specified periods.
    //
    //  Query params (all required):
    //    facilityIds[]  — NearestHFID values; omit = all user-accessible facilities
    //    cfStart/cfEnd  — YYYY-MM-DD  new-registration (CF) period
    //    toStart/toEnd  — YYYY-MM-DD  treatment-outcome (TO) period
    //    cfYear         — integer year of the CF period (for skipped-TBNo check)
    //
    //  SECURITY:
    //    - [Authorize] is inherited from the class attribute.
    //    - Facility-level JWT users are hard-locked to their own facility.
    //    - All SQL values are bound as SqlParameters — no user input concatenated.
    //    - Date inputs are validated via DateOnly.TryParse before any SQL is run.
    // ───────────────────────────────────────────────────────────────────────
    [HttpGet("dq-counts")]
    public async Task<IActionResult> GetDQCounts(
        [FromQuery] int[]?  facilityIds = null,
        [FromQuery] string? cfStart     = null,
        [FromQuery] string? cfEnd       = null,
        [FromQuery] string? toStart     = null,
        [FromQuery] string? toEnd       = null,
        [FromQuery] string? scStart     = null,
        [FromQuery] string? scEnd       = null,
        [FromQuery] int     cfYear      = 0)
    {
        if (!DateOnly.TryParse(cfStart, out var cfS) ||
            !DateOnly.TryParse(cfEnd,   out var cfE) ||
            !DateOnly.TryParse(toStart, out var toS) ||
            !DateOnly.TryParse(toEnd,   out var toE))
            return BadRequest(new { error = "cfStart, cfEnd, toStart, toEnd must be valid dates (yyyy-MM-dd)." });

        // scStart/scEnd are optional (computed client-side as CF minus 3 months)
        DateOnly? scS = DateOnly.TryParse(scStart, out var _scS) ? _scS : null;
        DateOnly? scE = DateOnly.TryParse(scEnd,   out var _scE) ? _scE : null;

        if (cfE < cfS || toE < toS)
            return BadRequest(new { error = "End date must not be before start date." });

        // Enforce facility scope from JWT (same pattern as ReportsController)
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        int minYear  = (cfYear > 0 ? cfYear : DateTime.Today.Year) - 1;

        // Build parameterised facility IN clause (alias 'p' for outer, 'd' for inner correlated)
        string facP = string.Empty, facD = string.Empty;
        var    facPrms = new List<(string Name, int Value)>();
        if (cleanIds.Length > 0)
        {
            var names = cleanIds.Select((_, i) => $"@FId{i}").ToArray();
            var inSql = string.Join(", ", names);
            facP = $"AND p.NearestHFID IN ({inSql})";
            facD = $"AND d.NearestHFID IN ({inSql})";
            for (int i = 0; i < cleanIds.Length; i++)
                facPrms.Add(($"@FId{i}", cleanIds[i]));
        }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Helper: run a COUNT(*) scalar and return the integer result
            async Task<int> Scalar(string sql)
            {
                await using var cmd = new SqlCommand(sql, conn);
                cmd.Parameters.AddWithValue("@CfStart", cfS.ToDateTime(TimeOnly.MinValue));
                cmd.Parameters.AddWithValue("@CfEnd",   cfE.ToDateTime(TimeOnly.MinValue));
                cmd.Parameters.AddWithValue("@ToStart", toS.ToDateTime(TimeOnly.MinValue));
                cmd.Parameters.AddWithValue("@ToEnd",   toE.ToDateTime(TimeOnly.MinValue));
                cmd.Parameters.AddWithValue("@ScStart", scS.HasValue ? scS.Value.ToDateTime(TimeOnly.MinValue) : (object)DBNull.Value);
                cmd.Parameters.AddWithValue("@ScEnd",   scE.HasValue ? scE.Value.ToDateTime(TimeOnly.MinValue) : (object)DBNull.Value);
                cmd.Parameters.AddWithValue("@MinYear", minYear);
                foreach (var (n, v) in facPrms) cmd.Parameters.AddWithValue(n, v);
                var r = await cmd.ExecuteScalarAsync();
                return r == null || r == DBNull.Value ? 0 : Convert.ToInt32(r);
            }

            // 1. Duplicate patients (same name + age + sex + TBNo + regdate in same facility)
            int duplicates = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                WHERE p.Deleted=0 {facP}
                  AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                  AND p.PtName != ''
                  AND EXISTS (
                        SELECT 1 FROM PtDetailsT d
                        WHERE d.Deleted=0 AND d.PtDetailsTID != p.PtDetailsTID {facD}
                          AND d.PtName != ''
                          AND UPPER(LTRIM(RTRIM(d.PtName))) = UPPER(LTRIM(RTRIM(p.PtName)))
                          AND COALESCE(d.Age,  -1) = COALESCE(p.Age,  -1)
                          AND COALESCE(d.SexID,-1) = COALESCE(p.SexID,-1)
                          AND COALESCE(d.UnitTBNo,'') = COALESCE(p.UnitTBNo,'')
                          AND COALESCE(CONVERT(nvarchar(10),d.RegDate,23),'')
                            = COALESCE(CONVERT(nvarchar(10),p.RegDate,23),''))
                """);

            // 2. Same TBMU number in same facility + year
            int sametbno = await Scalar($"""
                WITH norm AS (
                    SELECT p.PtDetailsTID, p.NearestHFID,
                           YEAR(p.RegDate)                                                  AS RegYear,
                           TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                    FROM PtDetailsT p
                    WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!=''
                      AND p.RegDate IS NOT NULL
                      AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd {facP}
                ),
                dupes AS (
                    SELECT NearestHFID, RegYear, TBNoB
                    FROM norm WHERE TBNoB > 0
                    GROUP BY NearestHFID, RegYear, TBNoB HAVING COUNT(*) > 1
                )
                SELECT COUNT(*) FROM norm n
                JOIN dupes dk ON dk.NearestHFID=n.NearestHFID
                              AND dk.RegYear=n.RegYear AND dk.TBNoB=n.TBNoB
                WHERE n.TBNoB > 0
                """);

            // 3. Missing essential registration fields
            int missingreg = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                WHERE p.Deleted=0 {facP}
                  AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                  AND (p.PtName IS NULL OR p.PtName=''
                    OR p.Age=0 OR p.Age IS NULL
                    OR p.SexID=0 OR p.TbTypeID=0 OR p.PtTypeID=0
                    OR p.RegDate IS NULL
                    OR p.DateRxStarted IS NULL OR p.DiagMethodID=0)
                """);

            // 4. Diagnostic method not recorded
            int diagmethod = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0 {facP}
                  AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                """);

            // 6a. Smear-positive patients who missed the 2-month sputum exam
            // Applies to New Pulmonary patients (PtTypeID=1, TbTypeID=1) who were
            // smear/GeneXpert positive at start but have no 2-month smear recorded.
            // DateRxStarted is filtered to the Sputum Conversion (SC) quarter.
            int scmissed2 = scS.HasValue && scE.HasValue ? await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                WHERE p.Deleted=0 {facP}
                  AND p.DateRxStarted >= @ScStart AND p.DateRxStarted <= @ScEnd
                  AND p.PtTypeID=1 AND p.TbTypeID=1
                  AND (COALESCE(fu.Mon0LabResultID,0)   IN (1,4,5,6)
                    OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))
                  AND COALESCE(fu.Mon2LabResultID,0) IN (0,3,7)
                """) : 0;

            // 5b. Smear-positive patients who missed the 3-month sputum exam
            // Same eligibility as above, but the 2-month result was still positive
            // (re-examination required) and the 3-month smear was not done.
            int scmissed3 = scS.HasValue && scE.HasValue ? await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                WHERE p.Deleted=0 {facP}
                  AND p.DateRxStarted >= @ScStart AND p.DateRxStarted <= @ScEnd
                  AND p.PtTypeID=1 AND p.TbTypeID=1
                  AND (COALESCE(fu.Mon0LabResultID,0)   IN (1,4,5,6)
                    OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))
                  AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6)
                  AND COALESCE(fu.Mon3LabResultID,0) IN (0,3,7)
                """) : 0;

            // 6. Missing treatment outcome (old enough to expect one but none recorded)
            int nooutcome = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                WHERE p.Deleted=0
                  AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd
                  AND p.DateRxStarted IS NOT NULL
                  AND p.PtTypeID NOT IN (0,5,7)
                  AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7)) {facP}
                  AND (   (p.PtTypeID = 1            AND DATEDIFF(day, p.DateRxStarted, GETDATE()) > 168)
                       OR (p.PtTypeID IN (2,3,4,6)   AND DATEDIFF(day, p.DateRxStarted, GETDATE()) > 224))
                """);

            // 7. Smear-negative patient declared Cured
            int smearcured = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                WHERE p.Deleted=0
                  AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd
                  AND COALESCE(fu.OutcomeID,0) = 1
                  AND COALESCE(fu.Mon0LabResultID,0)   NOT IN (1,4,5,6)
                  AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) {facP}
                """);

            // 8. Outcome recorded as "Not Evaluated"
            int notevaluated = await Scalar($"""
                SELECT COUNT(*) FROM PtDetailsT p
                JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                WHERE p.Deleted=0 AND fu.OutcomeID=6
                  AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd {facP}
                """);

            // 9. Skipped (gapped) TB register numbers per facility per year
            // SQL Server recursive CTE — OPTION(MAXRECURSION 2000) matches the
            // local SQLite TBNoB < 2000 cap so the two sources produce identical counts.
            int skipped = await Scalar($"""
                WITH normalized AS (
                    SELECT p.NearestHFID,
                           YEAR(p.RegDate)                                                  AS RegYear,
                           TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                    FROM PtDetailsT p
                    WHERE p.Deleted=0 AND p.NearestHFID IS NOT NULL AND p.PtTypeID <> 5
                      AND p.RegDate IS NOT NULL AND YEAR(p.RegDate) >= @MinYear
                      AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo != '' {facP}
                ),
                valid AS (
                    SELECT NearestHFID, RegYear, TBNoB FROM normalized
                    WHERE TBNoB > 0 AND TBNoB < 2000
                ),
                rngs AS (
                    SELECT NearestHFID, RegYear, MIN(TBNoB) AS MinNo, MAX(TBNoB) AS MaxNo
                    FROM valid GROUP BY NearestHFID, RegYear
                ),
                ideal(NearestHFID, RegYear, SeqNo, MaxNo) AS (
                    SELECT NearestHFID, RegYear, MinNo, MaxNo FROM rngs WHERE MaxNo > 0
                    UNION ALL
                    SELECT NearestHFID, RegYear, SeqNo + 1, MaxNo
                    FROM   ideal WHERE SeqNo < MaxNo
                ),
                gaps AS (
                    SELECT i.NearestHFID, i.RegYear, i.SeqNo
                    FROM   ideal i
                    LEFT JOIN valid v ON v.NearestHFID=i.NearestHFID
                                     AND v.RegYear=i.RegYear AND v.TBNoB=i.SeqNo
                    WHERE  v.TBNoB IS NULL
                )
                SELECT COUNT(*) FROM gaps
                OPTION (MAXRECURSION 2000)
                """);

            _logger.LogInformation(
                "DQ counts by {User}: dup={D} sametbno={S} misreg={M} diag={Di} sc2={Sc2} sc3={Sc3} noout={N} smear={Sm} notev={Nv} skip={Sk}",
                User.Identity?.Name, duplicates, sametbno, missingreg, diagmethod,
                scmissed2, scmissed3, nooutcome, smearcured, notevaluated, skipped);

            return Ok(new { duplicates, sametbno, missingreg, diagmethod,
                            scmissed2, scmissed3,
                            nooutcome, smearcured, notevaluated, skipped });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DQ counts error for user {User}", User.Identity?.Name);
            return StatusCode(500, new { error = "Could not run data quality checks." });
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/dq-list
    //  Returns patient rows for one DQ category (used by the detail panel).
    //  Accepts the same date / facility params as dq-counts, plus:
    //    category — one of: duplicates|sametbno|missingreg|diagmethod|
    //                        nooutcome|smearcured|notevaluated|skipped
    //
    //  SECURITY: same scope enforcement and parameterisation as dq-counts.
    // ───────────────────────────────────────────────────────────────────────
    [HttpGet("dq-list")]
    public async Task<IActionResult> GetDQList(
        [FromQuery] string? category    = null,
        [FromQuery] int[]?  facilityIds = null,
        [FromQuery] string? cfStart     = null,
        [FromQuery] string? cfEnd       = null,
        [FromQuery] string? toStart     = null,
        [FromQuery] string? toEnd       = null,
        [FromQuery] string? scStart     = null,
        [FromQuery] string? scEnd       = null,
        [FromQuery] int     cfYear      = 0)
    {
        var validCategories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "duplicates","sametbno","missingreg","diagmethod",
              "scmissed2","scmissed3",
              "nooutcome","smearcured","notevaluated","skipped" };

        if (string.IsNullOrWhiteSpace(category) || !validCategories.Contains(category))
            return BadRequest(new { error = "Invalid or missing category." });

        if (!DateOnly.TryParse(cfStart, out var cfS) ||
            !DateOnly.TryParse(cfEnd,   out var cfE) ||
            !DateOnly.TryParse(toStart, out var toS) ||
            !DateOnly.TryParse(toEnd,   out var toE))
            return BadRequest(new { error = "cfStart, cfEnd, toStart, toEnd must be valid dates (yyyy-MM-dd)." });

        // scStart/scEnd are optional
        DateOnly? scS = DateOnly.TryParse(scStart, out var _scSL) ? _scSL : null;
        DateOnly? scE = DateOnly.TryParse(scEnd,   out var _scEL) ? _scEL : null;

        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        int minYear  = (cfYear > 0 ? cfYear : DateTime.Today.Year) - 1;

        string facP = string.Empty, facD = string.Empty;
        var    facPrms = new List<(string Name, int Value)>();
        if (cleanIds.Length > 0)
        {
            var names = cleanIds.Select((_, i) => $"@FId{i}").ToArray();
            var inSql = string.Join(", ", names);
            facP = $"AND p.NearestHFID IN ({inSql})";
            facD = $"AND d.NearestHFID IN ({inSql})";
            for (int i = 0; i < cleanIds.Length; i++)
                facPrms.Add(($"@FId{i}", cleanIds[i]));
        }

        // Standard patient columns returned by every non-skipped category
        const string StdCols = """
            p.PtDetailsTID,
            p.UnitTBNo,
            CONVERT(nvarchar(10), p.RegDate,       23) AS RegDate,
            p.PtName, p.Age, p.AgeMonths, p.SexID,
            p.TbTypeID, p.PtTypeID, p.DiagMethodID,
            CONVERT(nvarchar(10), p.DateRxStarted, 23) AS DateRxStarted,
            p.NearestHFID, p.Village, p.Payam, p.PtPhone,
            COALESCE(hf.HealthFacility,'') AS HealthFacility,
            COALESCE(s.Sex,'')             AS Sex,
            COALESCE(pt.PtTypeShort,'')    AS PtTypeShort,
            COALESCE(tt.TbType,'')         AS TbType,
            COALESCE(dm.DiagMethod,'')     AS DiagMethod
            """;

        const string StdJoins = """
            FROM PtDetailsT p
            LEFT JOIN SexT            s  ON p.SexID        = s.SexID
            LEFT JOIN PtTypeT         pt ON p.PtTypeID     = pt.PtTypeID
            LEFT JOIN TbTypeT         tt ON p.TbTypeID     = tt.TbTypeID
            LEFT JOIN DiagMethodT     dm ON p.DiagMethodID = dm.DiagMethodID
            LEFT JOIN HealthFacilityT hf ON p.NearestHFID  = hf.HealthFacilityID
            """;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            string sql = category.ToLowerInvariant() switch
            {
                "duplicates" => $"""
                    SELECT {StdCols}
                    {StdJoins}
                    WHERE p.Deleted=0 {facP}
                      AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                      AND p.PtName != ''
                      AND EXISTS (
                            SELECT 1 FROM PtDetailsT d
                            WHERE d.Deleted=0 AND d.PtDetailsTID != p.PtDetailsTID {facD}
                              AND d.PtName != ''
                              AND UPPER(LTRIM(RTRIM(d.PtName))) = UPPER(LTRIM(RTRIM(p.PtName)))
                              AND COALESCE(d.Age,  -1) = COALESCE(p.Age,  -1)
                              AND COALESCE(d.SexID,-1) = COALESCE(p.SexID,-1)
                              AND COALESCE(d.UnitTBNo,'') = COALESCE(p.UnitTBNo,'')
                              AND COALESCE(CONVERT(nvarchar(10),d.RegDate,23),'')
                                = COALESCE(CONVERT(nvarchar(10),p.RegDate,23),''))
                    ORDER BY p.PtName, p.RegDate
                    """,

                "sametbno" => $"""
                    WITH norm AS (
                        SELECT p.PtDetailsTID, p.NearestHFID,
                               YEAR(p.RegDate)                                                  AS RegYear,
                               TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                        FROM PtDetailsT p
                        WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!=''
                          AND p.RegDate IS NOT NULL
                          AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd {facP}
                    ),
                    dupes AS (
                        SELECT NearestHFID, RegYear, TBNoB FROM norm WHERE TBNoB > 0
                        GROUP BY NearestHFID, RegYear, TBNoB HAVING COUNT(*) > 1
                    )
                    SELECT {StdCols}
                    {StdJoins}
                    JOIN norm  n  ON n.PtDetailsTID  = p.PtDetailsTID
                    JOIN dupes dk ON dk.NearestHFID  = n.NearestHFID
                                 AND dk.RegYear      = n.RegYear
                                 AND dk.TBNoB        = n.TBNoB
                    WHERE p.Deleted=0 {facP}
                    ORDER BY n.RegYear DESC, n.TBNoB, p.RegDate
                    """,

                "missingreg" => $"""
                    SELECT {StdCols},
                           STUFF(
                             CASE WHEN p.PtName IS NULL OR p.PtName='' THEN ', Patient Name' ELSE '' END +
                             CASE WHEN p.Age=0  OR p.Age IS NULL       THEN ', Age'          ELSE '' END +
                             CASE WHEN p.SexID=0                       THEN ', Sex'          ELSE '' END +
                             CASE WHEN p.TbTypeID=0                    THEN ', TB Site'      ELSE '' END +
                             CASE WHEN p.PtTypeID=0                    THEN ', Patient Type' ELSE '' END +
                             CASE WHEN p.RegDate IS NULL                THEN ', Reg Date'     ELSE '' END +
                             CASE WHEN p.DateRxStarted IS NULL          THEN ', Rx Start'     ELSE '' END +
                             CASE WHEN p.DiagMethodID=0                THEN ', Diag Method'  ELSE '' END
                           , 1, 2, '') AS MissingFields
                    {StdJoins}
                    WHERE p.Deleted=0 {facP}
                      AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                      AND (p.PtName IS NULL OR p.PtName=''
                        OR p.Age=0 OR p.Age IS NULL OR p.SexID=0
                        OR p.TbTypeID=0 OR p.PtTypeID=0 OR p.RegDate IS NULL
                        OR p.DateRxStarted IS NULL OR p.DiagMethodID=0)
                    ORDER BY p.PtName
                    """,

                "diagmethod" => $"""
                    SELECT {StdCols}
                    {StdJoins}
                    WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0 {facP}
                      AND p.RegDate >= @CfStart AND p.RegDate <= @CfEnd
                    ORDER BY p.PtName
                    """,

                // Smear-positive patients who missed the 2-month sputum exam
                // (New Pulmonary, smear/Xpert positive at start, Mon2 not done)
                "scmissed2" => $"""
                    SELECT {StdCols}
                    {StdJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    WHERE p.Deleted=0 {facP}
                      AND p.PtTypeID=1 AND p.TbTypeID=1
                      AND (@ScStart IS NULL OR p.DateRxStarted >= @ScStart)
                      AND (@ScEnd   IS NULL OR p.DateRxStarted <= @ScEnd)
                      AND (COALESCE(fu.Mon0LabResultID,0)   IN (1,4,5,6)
                        OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))
                      AND COALESCE(fu.Mon2LabResultID,0) IN (0,3,7)
                    ORDER BY p.DateRxStarted
                    """,

                // Smear-positive patients who missed the 3-month sputum exam
                // (was still positive at 2 months, re-exam at 3 months not done)
                "scmissed3" => $"""
                    SELECT {StdCols}
                    {StdJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    WHERE p.Deleted=0 {facP}
                      AND p.PtTypeID=1 AND p.TbTypeID=1
                      AND (@ScStart IS NULL OR p.DateRxStarted >= @ScStart)
                      AND (@ScEnd   IS NULL OR p.DateRxStarted <= @ScEnd)
                      AND (COALESCE(fu.Mon0LabResultID,0)   IN (1,4,5,6)
                        OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))
                      AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6)
                      AND COALESCE(fu.Mon3LabResultID,0) IN (0,3,7)
                    ORDER BY p.DateRxStarted
                    """,

                "nooutcome" => $"""
                    SELECT {StdCols},
                           p.RegimenID,
                           COALESCE(o.Outcome,'')                           AS Outcome,
                           DATEDIFF(day, p.DateRxStarted, GETDATE())        AS DaysSinceStart
                    {StdJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT    o  ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0
                      AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd
                      AND p.DateRxStarted IS NOT NULL
                      AND p.PtTypeID NOT IN (0,5,7)
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7)) {facP}
                      AND (   (p.PtTypeID=1            AND DATEDIFF(day, p.DateRxStarted, GETDATE()) > 168)
                           OR (p.PtTypeID IN (2,3,4,6) AND DATEDIFF(day, p.DateRxStarted, GETDATE()) > 224))
                    ORDER BY p.DateRxStarted
                    """,

                "smearcured" => $"""
                    SELECT {StdCols},
                           COALESCE(o.Outcome,'') AS Outcome
                    {StdJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT    o  ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0
                      AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd
                      AND COALESCE(fu.OutcomeID,0) = 1
                      AND COALESCE(fu.Mon0LabResultID,0)   NOT IN (1,4,5,6)
                      AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) {facP}
                    ORDER BY p.PtName
                    """,

                "notevaluated" => $"""
                    SELECT {StdCols},
                           p.RegimenID,
                           COALESCE(o.Outcome,'')                    AS Outcome,
                           DATEDIFF(day, p.DateRxStarted, GETDATE()) AS DaysSinceStart
                    {StdJoins}
                    JOIN  PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT o ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0 AND fu.OutcomeID=6
                      AND p.DateRxStarted >= @ToStart AND p.DateRxStarted <= @ToEnd {facP}
                    ORDER BY p.PtName
                    """,

                "skipped" => $"""
                    WITH normalized AS (
                        SELECT p.NearestHFID,
                               YEAR(p.RegDate)                                                  AS RegYear,
                               TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                        FROM PtDetailsT p
                        WHERE p.Deleted=0 AND p.NearestHFID IS NOT NULL AND p.PtTypeID <> 5
                          AND p.RegDate IS NOT NULL AND YEAR(p.RegDate) >= @MinYear
                          AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo != '' {facP}
                    ),
                    valid AS (
                        SELECT NearestHFID, RegYear, TBNoB FROM normalized
                        WHERE TBNoB > 0 AND TBNoB < 2000
                    ),
                    rngs AS (
                        SELECT NearestHFID, RegYear, MIN(TBNoB) AS MinNo, MAX(TBNoB) AS MaxNo
                        FROM valid GROUP BY NearestHFID, RegYear
                    ),
                    ideal(NearestHFID, RegYear, SeqNo, MaxNo) AS (
                        SELECT NearestHFID, RegYear, MinNo, MaxNo FROM rngs WHERE MaxNo > 0
                        UNION ALL
                        SELECT NearestHFID, RegYear, SeqNo + 1, MaxNo
                        FROM   ideal WHERE SeqNo < MaxNo
                    ),
                    gaps AS (
                        SELECT i.NearestHFID, i.RegYear, i.SeqNo AS MissingTBNo
                        FROM   ideal i
                        LEFT JOIN valid v ON v.NearestHFID=i.NearestHFID
                                         AND v.RegYear=i.RegYear AND v.TBNoB=i.SeqNo
                        WHERE  v.TBNoB IS NULL
                    )
                    SELECT g.MissingTBNo, g.RegYear,
                           COALESCE(hf.HealthFacility,'') AS HealthFacility
                    FROM   gaps g
                    LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID = g.NearestHFID
                    ORDER BY g.RegYear DESC, g.MissingTBNo DESC
                    OPTION (MAXRECURSION 2000)
                    """,

                _ => throw new InvalidOperationException("Unhandled category.")
            };

            await using var cmd = new SqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("@CfStart", cfS.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@CfEnd",   cfE.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@ToStart", toS.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@ToEnd",   toE.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@ScStart", scS.HasValue ? scS.Value.ToDateTime(TimeOnly.MinValue) : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("@ScEnd",   scE.HasValue ? scE.Value.ToDateTime(TimeOnly.MinValue) : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("@MinYear", minYear);
            foreach (var (n, v) in facPrms) cmd.Parameters.AddWithValue(n, v);

            var rows = new List<Dictionary<string, object?>>();
            await using var rdr = await cmd.ExecuteReaderAsync();
            while (await rdr.ReadAsync())
            {
                var row = new Dictionary<string, object?>();
                for (int i = 0; i < rdr.FieldCount; i++)
                    row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                rows.Add(row);
            }

            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "DQ list error (cat={Cat}) for user {User}", category, User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve data quality details." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/{id}
    //  Returns the full record payload for a single TB patient (registration
    //  + follow-up), in the same shape as GET /api/tb-patients/mine, so the
    //  PWA can upsert it locally before opening the edit/view form.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("{id}")]
    public async Task<IActionResult> GetOne(string id)
    {
        if (!Guid.TryParse(id, out var tid))
            return BadRequest(new { error = "Invalid patient ID." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            const string patSql = """
                SELECT
                    CAST(PtDetailsTID AS nvarchar(36))            AS PtDetailsTID,
                    HasChanged, Deleted, NearestHFID, DataSourceID, CountyID,
                    CAST(EnteredByID AS nvarchar(36))              AS EnteredByID,
                    CONVERT(nvarchar(30), LastModOn,          126) AS LastModOn,
                    CONVERT(nvarchar(30), CreatedOn,          126) AS CreatedOn,
                    CONVERT(nvarchar(10), RegDate,             23) AS RegDate,
                    UnitTBNo, PtName,
                    CONVERT(nvarchar(10), DateOfBirth,         23) AS DateOfBirth,
                    Age, AgeMonths, SexID, ReferredByID,
                    Village, Boma, Payam, County, PtPhone,
                    TbTypeID, PtTypeID, TIHF, TICounty,
                    CONVERT(nvarchar(10), DateRxStarted,       23) AS DateRxStarted,
                    RegimenID, DiagMethodID, CountryID
                FROM PtDetailsT
                WHERE PtDetailsTID = @TID
                  AND ISNULL(Deleted, 0) = 0
                """;

            var patients = new List<Dictionary<string, object?>>();
            await using (var cmd = new SqlCommand(patSql, conn))
            {
                cmd.Parameters.AddWithValue("@TID", tid);
                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < rdr.FieldCount; i++)
                        row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                    patients.Add(row);
                }
            }

            if (patients.Count == 0)
                return NotFound(new { error = "Patient not found." });

            const string fuSql = """
                SELECT
                    CAST(PtFollowUpTID AS nvarchar(36)) AS PtFollowUpTID,
                    CAST(PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                    HasChanged, Deleted,
                    CAST(EnteredByID AS nvarchar(36))           AS EnteredByID,
                    CONVERT(nvarchar(30), LastModOn, 126)       AS LastModOn,
                    CONVERT(nvarchar(30), CreatedOn,  126)      AS CreatedOn,
                    CONVERT(nvarchar(10), Mon0Date,          23) AS Mon0Date,
                    Mon0LabNo, Mon0LabResultID,
                    CONVERT(nvarchar(10), Mon0XpertResultDate, 23) AS Mon0XpertResultDate,
                    Mon0XpertResultID,
                    CONVERT(nvarchar(10), HIVTestDate,       23) AS HIVTestDate,
                    HIVTestResultID, DSTResult,
                    CONVERT(nvarchar(10), Mon2Date,          23) AS Mon2Date,
                    Mon2LabNo, Mon2LabResultID,
                    CONVERT(nvarchar(10), Mon3Date,          23) AS Mon3Date,
                    Mon3LabNo, Mon3LabResultID,
                    CONVERT(nvarchar(10), Mon5Date,          23) AS Mon5Date,
                    Mon5LabNo, Mon5LabResultID,
                    CONVERT(nvarchar(10), Mon6Date,          23) AS Mon6Date,
                    Mon6LabNo, Mon6LabResultID,
                    OutcomeID,
                    CONVERT(nvarchar(10), OutcomeDate,       23) AS OutcomeDate,
                    TOHF, TOCounty, OnART,
                    CONVERT(nvarchar(10), ARTDate,           23) AS ARTDate,
                    OnCPT,
                    CONVERT(nvarchar(10), CPTDate,           23) AS CPTDate,
                    MovedTo2ndLine, Remarks
                FROM PtFollowUpT WHERE PtDetailsTID = @TID
                """;

            var followUps = new List<Dictionary<string, object?>>();
            await using (var cmd = new SqlCommand(fuSql, conn))
            {
                cmd.Parameters.AddWithValue("@TID", tid);
                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < rdr.FieldCount; i++)
                        row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                    followUps.Add(row);
                }
            }

            return Ok(new { patients, followUps });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in TB GetOne for patient {TID}.", tid);
            return StatusCode(500, new { error = "Could not retrieve TB patient record." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Private helpers shared by the monitoring/quality endpoints below.
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Builds a parameterised NearestHFID IN (…) clause for p-alias.
    /// Returns empty string when <paramref name="cleanIds"/> is empty (= no filter).
    /// </summary>
    private static (string Clause, List<(string Name, int Value)> Prms)
        FacFilter(int[] cleanIds, string alias = "p")
    {
        if (cleanIds.Length == 0) return (string.Empty, []);
        var names = cleanIds.Select((_, i) => $"@FId{i}").ToArray();
        var inSql = string.Join(", ", names);
        var prms  = cleanIds.Select((v, i) => ($"@FId{i}", v)).ToList();
        return ($"AND {alias}.NearestHFID IN ({inSql})", prms);
    }

    /// <summary>
    /// Adds each (name, value) pair in <paramref name="prms"/> to <paramref name="cmd"/>.
    /// </summary>
    private static void AddFacParams(SqlCommand cmd, List<(string Name, int Value)> prms)
    {
        foreach (var (n, v) in prms) cmd.Parameters.AddWithValue(n, v);
    }

    /// <summary>
    /// Reads all rows from <paramref name="rdr"/> into a list of dictionaries.
    /// GUIDs are lowercased to match the PWA's convention.
    /// </summary>
    private static async Task<List<Dictionary<string, object?>>> ReadRowsAsync(SqlDataReader rdr)
    {
        var rows = new List<Dictionary<string, object?>>();
        while (await rdr.ReadAsync())
        {
            var row = new Dictionary<string, object?>();
            for (int i = 0; i < rdr.FieldCount; i++)
                row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/monitor-facilities
    //  Returns health facilities that have active TB patients on treatment.
    //  Used to populate the monitoring tree when the user has no local data.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("monitor-facilities")]
    public async Task<IActionResult> GetMonitorFacilities()
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        int.TryParse(User.FindFirstValue("county_id"),   out var userCountyId);
        int.TryParse(User.FindFirstValue("state_id"),    out var userStateId);

        // Build scope filter from JWT — never trust client for geo scope
        string scopeWhere = string.Empty;
        int    scopeId    = 0;
        if      (userFacilityId > 0) { scopeWhere = "AND p.NearestHFID = @ScopeId";  scopeId = userFacilityId; }
        else if (userCountyId   > 0) { scopeWhere = "AND hf.CountyID   = @ScopeId";  scopeId = userCountyId; }
        else if (userStateId    > 0) { scopeWhere = "AND hf.StateID    = @ScopeId";   scopeId = userStateId; }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            var sql = $"""
                SELECT DISTINCT hf.HealthFacilityID, hf.HealthFacility
                FROM PtDetailsT p
                INNER JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
                WHERE p.Deleted = 0
                  AND p.DateRxStarted IS NOT NULL
                  AND hf.HealthFacilityID > 0
                  {scopeWhere}
                ORDER BY hf.HealthFacility
                """;

            await using var cmd = new SqlCommand(sql, conn);
            if (scopeId > 0) cmd.Parameters.AddWithValue("@ScopeId", scopeId);
            await using var rdr = await cmd.ExecuteReaderAsync();
            var rows = await ReadRowsAsync(rdr);
            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetMonitorFacilities error (user {User})", User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve monitoring facilities." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/monitor-counts
    //  Returns the patient count for every monitoring category.
    //
    //  Query params:
    //    facilityIds[]  — facility IDs to filter (overridden for facility users)
    //    mode           — 'missed' (default) | 'due'
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("monitor-counts")]
    public async Task<IActionResult> GetMonitorCounts(
        [FromQuery] int[]?  facilityIds = null,
        [FromQuery] string  mode        = "missed")
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds  = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var (facP, facPrms) = FacFilter(cleanIds);
        bool missed = mode != "due";

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            async Task<int> MonCount(string extraWhere, int offset, int grace, bool sputum)
            {
                string modeFilter = sputum
                    ? (missed
                        ? $"AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} > 0 AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} <= {grace}"
                        : $"AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} <= 0")
                    : string.Empty;

                string sputumBase = sputum
                    ? "AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))"
                    : string.Empty;

                var sql = $"""
                    SELECT COUNT(*)
                    FROM PtDetailsT p
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0
                    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) = 0)
                      {sputumBase}
                      {extraWhere}
                      {facP}
                      {modeFilter}
                    """;
                await using var cmd = new SqlCommand(sql, conn);
                AddFacParams(cmd, facPrms);
                var r = await cmd.ExecuteScalarAsync();
                return r == null || r == DBNull.Value ? 0 : Convert.ToInt32(r);
            }

            async Task<int> MonCountInner(string extraWhere)
            {
                var sql = $"""
                    SELECT COUNT(*)
                    FROM PtDetailsT p
                    INNER JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0
                    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND COALESCE(fu.OutcomeID,0) = 0
                      {extraWhere}
                      {facP}
                    """;
                await using var cmd = new SqlCommand(sql, conn);
                AddFacParams(cmd, facPrms);
                var r = await cmd.ExecuteScalarAsync();
                return r == null || r == DBNull.Value ? 0 : Convert.ToInt32(r);
            }

            int sputum2  = await MonCount("AND (fu.PtFollowUpTID IS NULL OR fu.Mon2Date IS NULL)",                            56, 28, sputum: true);
            int sputum3  = await MonCount("AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6) AND (fu.PtFollowUpTID IS NULL OR fu.Mon3Date IS NULL)", 84, 56, sputum: true);
            int sputum5  = await MonCount("AND (fu.PtFollowUpTID IS NULL OR fu.Mon5Date IS NULL)",                           140, 28, sputum: true);
            int sputum6  = await MonCount("AND (fu.PtFollowUpTID IS NULL OR fu.Mon6Date IS NULL)",                           168, 56, sputum: true);
            int sputum8  = await MonCount("AND p.PtTypeID IN (2,3,4) AND (fu.PtFollowUpTID IS NULL OR fu.Mon6Date IS NULL)", 224, 56, sputum: true);
            int hiv      = await MonCount("AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.HIVTestResultID,0) IN (0,4) OR fu.HIVTestDate IS NULL)", 0, 0, sputum: false);
            int cpt      = await MonCountInner("AND fu.HIVTestResultID = 2 AND COALESCE(fu.OnCPT,0) = 0");
            int art      = await MonCountInner("AND fu.HIVTestResultID = 2 AND COALESCE(fu.OnART,0) = 0");
            int outcome;
            {
                var sql = $"""
                    SELECT COUNT(*)
                    FROM PtDetailsT p
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0
                    LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) = 0)
                      AND ((p.PtTypeID NOT IN (2,3,4) AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) > 168)
                        OR (p.PtTypeID IN (2,3,4)     AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) > 252))
                      {facP}
                    """;
                await using var cmd = new SqlCommand(sql, conn);
                AddFacParams(cmd, facPrms);
                var r = await cmd.ExecuteScalarAsync();
                outcome = r == null || r == DBNull.Value ? 0 : Convert.ToInt32(r);
            }

            return Ok(new { sputum2, sputum3, sputum5, sputum6, sputum8, hiv, cpt, art, hhp = 0, outcome });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetMonitorCounts error (user {User})", User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve monitoring counts." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/monitor-patients
    //  Returns the patient list for a single monitoring category.
    //
    //  Query params:
    //    facilityIds[]  — overridden for facility users
    //    mode           — 'missed' | 'due'
    //    category       — '2month'|'3month'|'5month'|'6month'|'8month'|
    //                     'hiv'|'cpt'|'art'|'outcome'
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("monitor-patients")]
    public async Task<IActionResult> GetMonitorPatients(
        [FromQuery] int[]?  facilityIds = null,
        [FromQuery] string  mode        = "missed",
        [FromQuery] string  category    = "2month")
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds        = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var (facP, facPrms) = FacFilter(cleanIds);
        bool missed         = mode != "due";

        // Base SELECT columns (sputum categories add DaysLate)
        const string baseColsSputum = """
            LOWER(CONVERT(nvarchar(36), p.PtDetailsTID)) AS PtDetailsTID,
            p.UnitTBNo,
            CONVERT(nvarchar(10), p.RegDate, 23) AS RegDate,
            p.PtName, p.Age, p.Village, p.Payam, p.PtPhone, p.PtTypeID, p.NearestHFID,
            ISNULL(s.Sex,'') AS Sex, ISNULL(pt.PtTypeShort,'') AS PtTypeShort,
            ISNULL(hf.HealthFacility,'') AS HealthFacility
            """;

        const string leftJoins = """
            FROM PtDetailsT p
            LEFT JOIN PtFollowUpT    fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0
            LEFT JOIN SexT            s ON p.SexID        = s.SexID
            LEFT JOIN PtTypeT        pt ON p.PtTypeID     = pt.PtTypeID
            LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
            """;

        const string innerJoins = """
            FROM PtDetailsT p
            INNER JOIN PtFollowUpT   fu ON p.PtDetailsTID = fu.PtDetailsTID AND fu.Deleted = 0
            LEFT JOIN SexT            s ON p.SexID        = s.SexID
            LEFT JOIN PtTypeT        pt ON p.PtTypeID     = pt.PtTypeID
            LEFT JOIN HealthFacilityT hf ON p.NearestHFID = hf.HealthFacilityID
            """;

        string querySql;
        switch (category)
        {
            case "2month": case "3month": case "5month": case "6month": case "8month":
            {
                (int offset, int grace, string extra) = category switch {
                    "2month" => (56,  28, "AND (fu.PtFollowUpTID IS NULL OR fu.Mon2Date IS NULL)"),
                    "3month" => (84,  56, "AND COALESCE(fu.Mon2LabResultID,0) IN (1,4,5,6) AND (fu.PtFollowUpTID IS NULL OR fu.Mon3Date IS NULL)"),
                    "5month" => (140, 28, "AND (fu.PtFollowUpTID IS NULL OR fu.Mon5Date IS NULL)"),
                    "6month" => (168, 56, "AND (fu.PtFollowUpTID IS NULL OR fu.Mon6Date IS NULL)"),
                    _        => (224, 56, "AND p.PtTypeID IN (2,3,4) AND (fu.PtFollowUpTID IS NULL OR fu.Mon6Date IS NULL)"),
                };
                string modeFilter = missed
                    ? $"AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} > 0 AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} <= {grace}"
                    : $"AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} <= 0";
                querySql = $"""
                    SELECT {baseColsSputum},
                           DATEDIFF(DAY,p.DateRxStarted,GETDATE()) - {offset} AS DaysLate
                    {leftJoins}
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) = 0)
                      AND (COALESCE(fu.Mon0LabResultID,0) IN (1,4,5,6) OR COALESCE(fu.Mon0XpertResultID,0) IN (3,4,5))
                      {extra}
                      {facP}
                      {modeFilter}
                    ORDER BY DaysLate DESC, p.PtName
                    """;
                break;
            }
            case "hiv":
                querySql = $"""
                    SELECT {baseColsSputum}
                    {leftJoins}
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) = 0)
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.HIVTestResultID,0) IN (0,4) OR fu.HIVTestDate IS NULL)
                      {facP}
                    ORDER BY p.PtName
                    """;
                break;
            case "cpt":
                querySql = $"""
                    SELECT {baseColsSputum}
                    {innerJoins}
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND COALESCE(fu.OutcomeID,0) = 0
                      AND fu.HIVTestResultID = 2
                      AND COALESCE(fu.OnCPT,0) = 0
                      {facP}
                    ORDER BY p.PtName
                    """;
                break;
            case "art":
                querySql = $"""
                    SELECT {baseColsSputum}
                    {innerJoins}
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND COALESCE(fu.OutcomeID,0) = 0
                      AND fu.HIVTestResultID = 2
                      AND COALESCE(fu.OnART,0) = 0
                      {facP}
                    ORDER BY p.PtName
                    """;
                break;
            case "outcome":
                querySql = $"""
                    SELECT {baseColsSputum},
                           DATEDIFF(DAY,p.DateRxStarted,GETDATE()) AS DaysSinceStart
                    {leftJoins}
                    WHERE p.Deleted = 0
                      AND p.DateRxStarted IS NOT NULL
                      AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) = 0)
                      AND ((p.PtTypeID NOT IN (2,3,4) AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) > 168)
                        OR (p.PtTypeID IN (2,3,4)     AND DATEDIFF(DAY,p.DateRxStarted,GETDATE()) > 252))
                      {facP}
                    ORDER BY DaysSinceStart DESC, p.PtName
                    """;
                break;
            default:
                return BadRequest(new { error = $"Unknown category '{category}'." });
        }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(querySql, conn);
            AddFacParams(cmd, facPrms);
            await using var rdr = await cmd.ExecuteReaderAsync();
            var rows = await ReadRowsAsync(rdr);
            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetMonitorPatients error cat={Cat} (user {User})", category, User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve monitoring patients." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/quality-counts
    //  Standalone (no date-range) DQ counts for all categories.
    //  Used by the "Check Data Quality" screen when the user has no local data.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("quality-counts")]
    public async Task<IActionResult> GetQualityCounts([FromQuery] int[]? facilityIds = null)
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds        = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var (facP, facPrms) = FacFilter(cleanIds);
        var (facD, facDPrms) = FacFilter(cleanIds, "d");
        int minYear = DateTime.Today.Year - 1;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            async Task<int> Cnt(string sql)
            {
                await using var cmd = new SqlCommand(sql, conn);
                AddFacParams(cmd, facPrms);
                cmd.Parameters.AddWithValue("@MinYear", minYear);
                var r = await cmd.ExecuteScalarAsync();
                return r == null || r == DBNull.Value ? 0 : Convert.ToInt32(r);
            }

            int all         = await Cnt($"SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID WHERE p.Deleted=0 {facP}");
            int duplicates  = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 {facP} AND p.PtName!=''
                AND EXISTS (SELECT 1 FROM PtDetailsT d LEFT JOIN HealthFacilityT hfd ON d.NearestHFID=hfd.HealthFacilityID
                            WHERE d.Deleted=0 AND d.PtDetailsTID!=p.PtDetailsTID {facD} AND d.PtName!=''
                            AND UPPER(LTRIM(RTRIM(d.PtName)))=UPPER(LTRIM(RTRIM(p.PtName)))
                            AND COALESCE(d.Age,-1)=COALESCE(p.Age,-1) AND COALESCE(d.SexID,-1)=COALESCE(p.SexID,-1)
                            AND COALESCE(d.UnitTBNo,'')=COALESCE(p.UnitTBNo,'')
                            AND COALESCE(CONVERT(nvarchar(10),d.RegDate,23),'')=COALESCE(CONVERT(nvarchar(10),p.RegDate,23),''))
                """);
            int sametbno = await Cnt($"""
                WITH norm AS (
                    SELECT p.PtDetailsTID, p.NearestHFID, YEAR(p.RegDate) AS RegYear,
                           TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                    FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                    WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!='' AND p.RegDate IS NOT NULL {facP}
                ),
                dupes AS (SELECT NearestHFID,RegYear,TBNoB FROM norm WHERE TBNoB>0 GROUP BY NearestHFID,RegYear,TBNoB HAVING COUNT(*)>1)
                SELECT COUNT(*) FROM norm n JOIN dupes dk ON dk.NearestHFID=n.NearestHFID AND dk.RegYear=n.RegYear AND dk.TBNoB=n.TBNoB WHERE n.TBNoB>0
                """);
            int missingreg = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 {facP}
                AND (p.PtName IS NULL OR p.PtName='' OR p.Age=0 OR p.Age IS NULL OR p.SexID=0 OR p.TbTypeID=0
                     OR p.PtTypeID=0 OR p.RegDate IS NULL OR p.DateRxStarted IS NULL OR p.DiagMethodID=0)
                """);
            int smearcured = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND COALESCE(fu.OutcomeID,0)=1
                AND COALESCE(fu.Mon0LabResultID,0) NOT IN (1,4,5,6)
                AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) {facP}
                """);
            int nooutcome = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p
                LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND p.DateRxStarted IS NOT NULL AND p.PtTypeID NOT IN (0,5,7)
                AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7))
                AND ((p.PtTypeID=1 AND DATEDIFF(DAY,p.DateRxStarted,GETDATE())>168)
                  OR (p.PtTypeID IN (2,3,4,6) AND DATEDIFF(DAY,p.DateRxStarted,GETDATE())>224)) {facP}
                """);
            int notevaluated = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p
                JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND fu.OutcomeID=6 {facP}
                """);
            int diagmethod = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0 {facP}
                """);
            int norxstart = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND p.DateRxStarted IS NULL AND p.RegDate IS NOT NULL
                AND DATEDIFF(DAY,p.RegDate,GETDATE())>14 {facP}
                """);
            int futuredates = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=0 AND p.RegDate > CONVERT(date,GETDATE()) {facP}
                """);
            int skipped = await Cnt($"""
                WITH norm AS (
                    SELECT p.NearestHFID, YEAR(p.RegDate) AS RegYear,
                           TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                    FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                    WHERE p.Deleted=0 AND p.PtTypeID!=5 AND p.RegDate IS NOT NULL AND YEAR(p.RegDate)>=@MinYear {facP}
                ),
                valid AS (SELECT NearestHFID, RegYear, TBNoB FROM norm WHERE TBNoB>0 AND TBNoB<2000),
                ranges AS (SELECT NearestHFID, RegYear, MIN(TBNoB) AS MinNo, MAX(TBNoB) AS MaxNo FROM valid GROUP BY NearestHFID, RegYear),
                seq AS (SELECT TOP 2000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL))-1 AS n FROM sys.objects CROSS JOIN sys.objects s2),
                expected AS (SELECT r.NearestHFID, r.RegYear, r.MinNo+s.n AS TBNoB FROM ranges r CROSS JOIN seq s WHERE r.MinNo+s.n<=r.MaxNo),
                gaps AS (SELECT e.NearestHFID, e.RegYear, e.TBNoB FROM expected e WHERE NOT EXISTS (SELECT 1 FROM valid v WHERE v.NearestHFID=e.NearestHFID AND v.RegYear=e.RegYear AND v.TBNoB=e.TBNoB))
                SELECT COUNT(*) FROM gaps
                """);
            int deleted = await Cnt($"""
                SELECT COUNT(*) FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                WHERE p.Deleted=1 {facP}
                """);

            return Ok(new { all, duplicates, skipped, sametbno, smearcured, missingreg, nooutcome, notevaluated, diagmethod, norxstart, futuredates, deleted });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetQualityCounts error (user {User})", User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve quality counts." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/tb-patients/quality-patients
    //  Returns the patient list for a standalone DQ category (no date filter).
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("quality-patients")]
    public async Task<IActionResult> GetQualityPatients(
        [FromQuery] int[]?  facilityIds = null,
        [FromQuery] string  category    = "all")
    {
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        if (userFacilityId > 0) facilityIds = [userFacilityId];

        var cleanIds        = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var (facP, facPrms) = FacFilter(cleanIds);
        var (facD, facDPrms) = FacFilter(cleanIds, "d");
        int minYear = DateTime.Today.Year - 1;

        const string dqCols = """
            LOWER(CONVERT(nvarchar(36), p.PtDetailsTID)) AS PtDetailsTID,
            p.UnitTBNo,
            CONVERT(nvarchar(10), p.RegDate, 23) AS RegDate,
            p.PtName, p.Age, p.AgeMonths, p.Village, p.Payam, p.PtPhone,
            p.SexID, p.TbTypeID, p.PtTypeID, p.DiagMethodID,
            CONVERT(nvarchar(10), p.DateRxStarted, 23) AS DateRxStarted,
            p.NearestHFID,
            ISNULL(s.Sex,'') AS Sex, ISNULL(pt.PtTypeShort,'') AS PtTypeShort,
            ISNULL(tt.TbType,'') AS TbType, ISNULL(dm.DiagMethod,'') AS DiagMethod,
            ISNULL(hf.HealthFacility,'') AS HealthFacility
            """;

        const string dqJoins = """
            FROM PtDetailsT p
            LEFT JOIN SexT            s  ON p.SexID        = s.SexID
            LEFT JOIN PtTypeT        pt  ON p.PtTypeID     = pt.PtTypeID
            LEFT JOIN TbTypeT        tt  ON p.TbTypeID     = tt.TbTypeID
            LEFT JOIN DiagMethodT    dm  ON p.DiagMethodID = dm.DiagMethodID
            LEFT JOIN HealthFacilityT hf ON p.NearestHFID  = hf.HealthFacilityID
            """;

        string querySql;
        switch (category)
        {
            case "all":
                querySql = $"SELECT {dqCols} {dqJoins} WHERE p.Deleted=0 {facP} ORDER BY p.PtName";
                break;
            case "duplicates":
                querySql = $"""
                    SELECT {dqCols} {dqJoins}
                    WHERE p.Deleted=0 {facP} AND p.PtName!=''
                    AND EXISTS (SELECT 1 FROM PtDetailsT d LEFT JOIN HealthFacilityT hfd ON d.NearestHFID=hfd.HealthFacilityID
                                WHERE d.Deleted=0 AND d.PtDetailsTID!=p.PtDetailsTID {facD} AND d.PtName!=''
                                AND UPPER(LTRIM(RTRIM(d.PtName)))=UPPER(LTRIM(RTRIM(p.PtName)))
                                AND COALESCE(d.Age,-1)=COALESCE(p.Age,-1) AND COALESCE(d.SexID,-1)=COALESCE(p.SexID,-1)
                                AND COALESCE(d.UnitTBNo,'')=COALESCE(p.UnitTBNo,'')
                                AND COALESCE(CONVERT(nvarchar(10),d.RegDate,23),'')=COALESCE(CONVERT(nvarchar(10),p.RegDate,23),''))
                    ORDER BY p.PtName, p.RegDate
                    """;
                break;
            case "sametbno":
                querySql = $"""
                    WITH norm AS (
                        SELECT p.PtDetailsTID, p.NearestHFID, YEAR(p.RegDate) AS RegYear,
                               TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB
                        FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                        WHERE p.Deleted=0 AND p.UnitTBNo IS NOT NULL AND p.UnitTBNo!='' AND p.RegDate IS NOT NULL {facP}
                    ),
                    dupes AS (SELECT NearestHFID,RegYear,TBNoB FROM norm WHERE TBNoB>0 GROUP BY NearestHFID,RegYear,TBNoB HAVING COUNT(*)>1)
                    SELECT {dqCols} {dqJoins}
                    JOIN norm n  ON n.PtDetailsTID = p.PtDetailsTID
                    JOIN dupes dk ON dk.NearestHFID=n.NearestHFID AND dk.RegYear=n.RegYear AND dk.TBNoB=n.TBNoB
                    WHERE p.Deleted=0 {facP} AND n.TBNoB>0
                    ORDER BY n.RegYear DESC, n.TBNoB, p.RegDate
                    """;
                break;
            case "smearcured":
                querySql = $"""
                    SELECT {dqCols}, ISNULL(o.Outcome,'') AS Outcome
                    {dqJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT     o ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0 AND COALESCE(fu.OutcomeID,0)=1
                    AND COALESCE(fu.Mon0LabResultID,0) NOT IN (1,4,5,6)
                    AND COALESCE(fu.Mon0XpertResultID,0) NOT IN (3,4,5) {facP}
                    ORDER BY p.PtName
                    """;
                break;
            case "missingreg":
                querySql = $"""
                    SELECT {dqCols},
                    LTRIM(
                      CASE WHEN p.PtName IS NULL OR p.PtName='' THEN 'Patient Name, ' ELSE '' END +
                      CASE WHEN p.Age=0 OR p.Age IS NULL THEN 'Age, ' ELSE '' END +
                      CASE WHEN p.SexID=0 THEN 'Sex, ' ELSE '' END +
                      CASE WHEN p.TbTypeID=0 THEN 'TB Site, ' ELSE '' END +
                      CASE WHEN p.PtTypeID=0 THEN 'Patient Type, ' ELSE '' END +
                      CASE WHEN p.RegDate IS NULL THEN 'Reg Date, ' ELSE '' END +
                      CASE WHEN p.DateRxStarted IS NULL THEN 'Rx Start Date, ' ELSE '' END +
                      CASE WHEN p.DiagMethodID=0 THEN 'Diag Method, ' ELSE '' END
                    ) AS MissingFields
                    {dqJoins}
                    WHERE p.Deleted=0 {facP}
                    AND (p.PtName IS NULL OR p.PtName='' OR p.Age=0 OR p.Age IS NULL OR p.SexID=0
                         OR p.TbTypeID=0 OR p.PtTypeID=0 OR p.RegDate IS NULL OR p.DateRxStarted IS NULL
                         OR p.DiagMethodID=0)
                    ORDER BY p.PtName
                    """;
                break;
            case "nooutcome":
                querySql = $"""
                    SELECT {dqCols}, ISNULL(o.Outcome,'') AS Outcome,
                           DATEDIFF(DAY,p.DateRxStarted,GETDATE()) AS DaysSinceStart
                    {dqJoins}
                    LEFT JOIN PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT     o ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0 AND p.DateRxStarted IS NOT NULL AND p.PtTypeID NOT IN (0,5,7)
                    AND (fu.PtFollowUpTID IS NULL OR COALESCE(fu.OutcomeID,0) IN (0,7))
                    AND ((p.PtTypeID=1 AND DATEDIFF(DAY,p.DateRxStarted,GETDATE())>168)
                      OR (p.PtTypeID IN (2,3,4,6) AND DATEDIFF(DAY,p.DateRxStarted,GETDATE())>224)) {facP}
                    ORDER BY p.DateRxStarted
                    """;
                break;
            case "notevaluated":
                querySql = $"""
                    SELECT {dqCols}, ISNULL(o.Outcome,'') AS Outcome,
                           DATEDIFF(DAY,p.DateRxStarted,GETDATE()) AS DaysSinceStart
                    {dqJoins}
                    JOIN  PtFollowUpT fu ON p.PtDetailsTID=fu.PtDetailsTID AND fu.Deleted=0
                    LEFT JOIN OutcomeT  o ON fu.OutcomeID=o.OutcomeID
                    WHERE p.Deleted=0 AND fu.OutcomeID=6 {facP}
                    ORDER BY p.DateRxStarted
                    """;
                break;
            case "diagmethod":
                querySql = $"SELECT {dqCols} {dqJoins} WHERE p.Deleted=0 AND COALESCE(p.DiagMethodID,0)=0 {facP} ORDER BY p.PtName";
                break;
            case "norxstart":
                querySql = $"""
                    SELECT {dqCols}, DATEDIFF(DAY,p.RegDate,GETDATE()) AS DaysSinceReg
                    {dqJoins}
                    WHERE p.Deleted=0 AND p.DateRxStarted IS NULL AND p.RegDate IS NOT NULL
                    AND DATEDIFF(DAY,p.RegDate,GETDATE())>14 {facP}
                    ORDER BY p.RegDate
                    """;
                break;
            case "futuredates":
                querySql = $"SELECT {dqCols} {dqJoins} WHERE p.Deleted=0 AND p.RegDate > CONVERT(date,GETDATE()) {facP} ORDER BY p.RegDate DESC";
                break;
            case "deleted":
                querySql = $"SELECT {dqCols} {dqJoins} WHERE p.Deleted=1 {facP} ORDER BY p.PtName";
                break;
            case "skipped":
                querySql = $"""
                    WITH norm AS (
                        SELECT p.NearestHFID, YEAR(p.RegDate) AS RegYear,
                               TRY_CAST(REPLACE(COALESCE(p.UnitTBNo,''),'\','/') AS INT) AS TBNoB,
                               hf.HealthFacility
                        FROM PtDetailsT p LEFT JOIN HealthFacilityT hf ON p.NearestHFID=hf.HealthFacilityID
                        WHERE p.Deleted=0 AND p.PtTypeID!=5 AND p.RegDate IS NOT NULL AND YEAR(p.RegDate)>=@MinYear {facP}
                    ),
                    valid AS (SELECT NearestHFID,RegYear,TBNoB,HealthFacility FROM norm WHERE TBNoB>0 AND TBNoB<2000),
                    ranges AS (SELECT NearestHFID,RegYear,HealthFacility,MIN(TBNoB) AS MinNo,MAX(TBNoB) AS MaxNo FROM valid GROUP BY NearestHFID,RegYear,HealthFacility),
                    seq AS (SELECT TOP 2000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL))-1 AS n FROM sys.objects CROSS JOIN sys.objects s2),
                    expected AS (SELECT r.NearestHFID,r.RegYear,r.HealthFacility,r.MinNo+s.n AS TBNoB FROM ranges r CROSS JOIN seq s WHERE r.MinNo+s.n<=r.MaxNo),
                    gaps AS (SELECT e.NearestHFID,e.RegYear,e.HealthFacility,e.TBNoB FROM expected e
                             WHERE NOT EXISTS (SELECT 1 FROM valid v WHERE v.NearestHFID=e.NearestHFID AND v.RegYear=e.RegYear AND v.TBNoB=e.TBNoB))
                    SELECT NULL AS PtDetailsTID, CAST(TBNoB AS nvarchar(10)) AS UnitTBNo,
                           CAST(RegYear AS nvarchar(4))+'-01-01' AS RegDate,
                           'Missing TB#'+CAST(TBNoB AS nvarchar(10))+'/'+CAST(RegYear AS nvarchar(4)) AS PtName,
                           NULL AS Age, NULL AS AgeMonths, NULL AS Village, NULL AS Payam, NULL AS PtPhone,
                           0 AS SexID, 0 AS TbTypeID, 0 AS PtTypeID, 0 AS DiagMethodID,
                           NULL AS DateRxStarted, NearestHFID,
                           '' AS Sex, '' AS PtTypeShort, '' AS TbType, '' AS DiagMethod, HealthFacility
                    FROM gaps ORDER BY RegYear DESC, NearestHFID, TBNoB
                    """;
                break;
            default:
                return BadRequest(new { error = $"Unknown category '{category}'." });
        }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var cmd = new SqlCommand(querySql, conn);
            AddFacParams(cmd, facPrms);
            // Also add facD params for duplicates (same param names, single conn)
            if (category == "duplicates") AddFacParams(cmd, facDPrms);
            cmd.Parameters.AddWithValue("@MinYear", minYear);
            await using var rdr = await cmd.ExecuteReaderAsync();
            var rows = await ReadRowsAsync(rdr);
            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetQualityPatients error cat={Cat} (user {User})", category, User.Identity?.Name);
            return StatusCode(500, new { error = "Could not retrieve quality patients." });
        }
    }
}
