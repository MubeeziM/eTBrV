using ClosedXML.Excel;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using System.Security.Claims;
using System.Text.Json;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Generates downloadable Excel reports for the ART programme.
///
/// SECURITY:
///   - [Authorize] on all endpoints — unauthenticated callers receive 401.
///   - All SQL uses parameterised queries — no string concatenation of user input.
///   - The geo WHERE clause is built from controlled boolean logic only;
///     all runtime values are bound as SqlParameters.
///   - Scope is enforced from JWT claims so users cannot query outside their
///     allowed geographic area.
///   - The template path is constructed server-side from ContentRootPath;
///     the file name is never taken from user input.
/// </summary>
[ApiController]
[Route("api/reports")]
[Authorize]
public sealed class ReportsController : ControllerBase
{
    private static readonly string[] MonthNames =
    {
        "", "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    };

    // Age-group index 0–11 maps to template rows 8–19
    private static readonly (int Min, int Max)[] AgeGroups =
    {
        (0,  0),   // 0  →  <1 YRS      row 8
        (1,  4),   // 1  →  1-4 YRS     row 9
        (5,  9),   // 2  →  5-9 YRS     row 10
        (10, 14),  // 3  →  10-14 YRS   row 11
        (15, 19),  // 4  →  15-19 YRS   row 12
        (20, 24),  // 5  →  20-24 YRS   row 13
        (25, 29),  // 6  →  25-29 YRS   row 14
        (30, 34),  // 7  →  30-34 YRS   row 15
        (35, 39),  // 8  →  35-39 YRS   row 16
        (40, 44),  // 9  →  40-44 YRS   row 17
        (45, 49),  // 10 →  45-49 YRS   row 18
        (50, 999), // 11 →  50+ YRS     row 19
    };

    // Page 2 per-regimen rows (51–93): RegimenCode (trimmed, case-insensitive) → Excel row.
    // Keys are lower-case so StringComparer.OrdinalIgnoreCase handles DB values like '1J'/'1j'.
    private static readonly Dictionary<string, int> RegimenCodeToRow =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // Adult 1st line
            ["1a"] = 51, ["1b"] = 52, ["1c"] = 53, ["1d"] = 54, ["1e"] = 55,
            ["1f"] = 56, ["1g"] = 57, ["1h"] = 58, ["1j"] = 59,
            // Adult 2nd line
            ["2a"] = 61, ["2b"] = 62, ["2c"] = 63, ["2d"] = 64, ["2e"] = 65,
            ["2f"] = 66, ["2g"] = 67, ["2h"] = 68, ["2i"] = 69, ["2j"] = 70,
            ["2k"] = 71,
            // Child 1st line
            ["4a"] = 73, ["4b"] = 74, ["4c"] = 75, ["4d"] = 76, ["4f"] = 77,
            ["4g"] = 78, ["4h"] = 79, ["4i"] = 80, ["4j"] = 81, ["4k"] = 82,
            ["4l"] = 83,
            // Child 2nd line
            ["5a"] = 85, ["5b"] = 86, ["5c"] = 87, ["5d"] = 88, ["5e"] = 89,
            ["5f"] = 90, ["5g"] = 91, ["5h"] = 92, ["5i"] = 93,
        };

    private readonly string _connectionString;
    private readonly ILogger<ReportsController> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly IMemoryCache _cache;

    // Payload stored in IMemoryCache between the SSE progress stream and the download request.
    private sealed record ReportCacheEntry(byte[] Bytes, string Filename);

    // Shared JSON serialiser options: camelCase property names for SSE events.
    private static readonly JsonSerializerOptions SseJsonOptions =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ReportsController(
        IConfiguration config,
        ILogger<ReportsController> logger,
        IWebHostEnvironment env,
        IMemoryCache cache)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
        _env    = env;
        _cache  = cache;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/art-monthly
    //      ?startDate=2026-05-01&endDate=2026-05-31[&facilityIds[]=n...]
    //
    //  startDate / endDate define the reporting window (ISO yyyy-MM-dd).
    //  The "previous cumulative" cut-off is startDate minus one day.
    //  The period label written into the Excel header is derived server-side
    //  from the date range so no unvalidated text comes from the client.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("art-monthly")]
    public async Task<IActionResult> ArtMonthly(
        [FromQuery] string startDate,
        [FromQuery] string endDate,
        [FromQuery] int[]? facilityIds = null)
    {
        if (!DateOnly.TryParse(startDate, out var periodStartDate))
            return BadRequest(new { error = "startDate must be a valid date (yyyy-MM-dd)." });
        if (!DateOnly.TryParse(endDate, out var periodEndDate))
            return BadRequest(new { error = "endDate must be a valid date (yyyy-MM-dd)." });
        if (periodEndDate < periodStartDate)
            return BadRequest(new { error = "endDate must be on or after startDate." });
        if (periodStartDate.Year < 2000 || periodEndDate.Year > 2100)
            return BadRequest(new { error = "Date range is outside the expected bounds (2000–2100)." });
        if (periodStartDate > DateOnly.FromDateTime(DateTime.Today))
        {
            var futurePeriodLabel = DerivePeriodLabel(periodStartDate, periodEndDate);
            return BadRequest(new { error = $"The ART report for {futurePeriodLabel} is not yet available. Please check back after {periodStartDate:MMMM d, yyyy}." });
        }

        var callerName = User.FindFirstValue(ClaimTypes.Name) ?? User.FindFirstValue("sub") ?? "unknown";
        _logger.LogInformation(
            "ART Report requested by {User} — startDate={Start}, endDate={End}, facilityIds=[{FacilityIds}]",
            callerName, startDate, endDate, string.Join(",", facilityIds ?? []));

        // ── Decode caller's scope from JWT ───────────────────────────────
        bool isNgo      = User.IsInRole("NGO");
        bool isNational = User.IsInRole("National");
        bool isZonal    = User.IsInRole("StateCoordinator");
        bool isDtls     = User.IsInRole("CountySupervisor");

        int.TryParse(User.FindFirstValue("facility_id"),  out var userFacilityId);
        int.TryParse(User.FindFirstValue("state_id"),     out var userStateId);
        int.TryParse(User.FindFirstValue("county_id"),    out var userCountyId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),   out var userSubRecId);
        int.TryParse(User.FindFirstValue("location_id"),  out var userLocationId);

        // ── Scope enforcement — narrow caller's selection to their allowed area ──
        // Facility staff are hard-locked to their own single facility.
        if (userFacilityId > 0)
            facilityIds = [userFacilityId];

        // ── Date range ───────────────────────────────────────────────────
        var periodStart = periodStartDate.ToDateTime(TimeOnly.MinValue);
        var periodEnd   = periodEndDate.ToDateTime(TimeOnly.MinValue);
        var prevEnd     = periodStart.AddDays(-1);   // last day before the period

        // ── Derive human-readable period label (server-side, not from client) ──
        var periodLabel = DerivePeriodLabel(periodStartDate, periodEndDate);
        var filePeriod  = DeriveFilePeriod(periodStartDate, periodEndDate);

        // ── Build parameterised geo WHERE clause ─────────────────────────
        // SECURITY: only controlled column-name strings appear in SQL text.
        // Every runtime value — including each element of facilityIds — is bound
        // as a named SqlParameter; no user input is ever concatenated.
        var cleanFacIds = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();

        var geoConditions = new List<string>();
        var sqlParams     = new Dictionary<string, object>
        {
            ["@PeriodStart"] = periodStart,
            ["@PeriodEnd"]   = periodEnd,
            ["@PrevEnd"]     = prevEnd,
        };

        if (cleanFacIds.Length > 0)
        {
            // Build IN (@FacId0, @FacId1, ...) — parameterised; no SQL injection risk.
            var paramNames = cleanFacIds.Select((_, i) => $"@FacId{i}");
            geoConditions.Add($"hf.HealthFacilityID IN ({string.Join(", ", paramNames)})");
            for (int i = 0; i < cleanFacIds.Length; i++)
                sqlParams[$"@FacId{i}"] = cleanFacIds[i];
        }

        // NGO scope: always AND the sub-recipient restriction as a security backstop.
        if (isNgo && userSubRecId > 0)
        {
            geoConditions.Add("hf.SubRecID = @SubRecId");
            sqlParams["@SubRecId"] = userSubRecId;
            // NGO field staff (state/county level): further restrict to their location.
            if ((isZonal || isDtls) && userLocationId > 0)
            {
                geoConditions.Add("hf.LocationID = @LocationId");
                sqlParams["@LocationId"] = userLocationId;
            }
        }

        var geoAnd = geoConditions.Count > 0
            ? "AND " + string.Join(" AND ", geoConditions)
            : string.Empty;

        // ── SQL: patient counts by sex × age-group, both periods ─────────
        // The CASE expression is entirely hardcoded — no user input reaches it.
        // All date/ID values are parameterised.
        const string AgeGroupCase = """
            CASE
                WHEN p.Age = 0                THEN 0
                WHEN p.Age BETWEEN 1  AND 4   THEN 1
                WHEN p.Age BETWEEN 5  AND 9   THEN 2
                WHEN p.Age BETWEEN 10 AND 14  THEN 3
                WHEN p.Age BETWEEN 15 AND 19  THEN 4
                WHEN p.Age BETWEEN 20 AND 24  THEN 5
                WHEN p.Age BETWEEN 25 AND 29  THEN 6
                WHEN p.Age BETWEEN 30 AND 34  THEN 7
                WHEN p.Age BETWEEN 35 AND 39  THEN 8
                WHEN p.Age BETWEEN 40 AND 44  THEN 9
                WHEN p.Age BETWEEN 45 AND 49  THEN 10
                ELSE 11
            END
            """;

        // Age bracket CASE for Page 2 summary rows (4 brackets: <10, 10-14, 15-49, 50+)
        const string AgeBracketCase = """
            CASE
                WHEN p.Age < 10                THEN 0
                WHEN p.Age BETWEEN 10 AND 14   THEN 1
                WHEN p.Age BETWEEN 15 AND 49   THEN 2
                ELSE 3
            END
            """;

        // ── Baseline-aware PrevCumul query ────────────────────────────────
        // For each facility that has a FacilityBaselineT record we only count
        // patients whose ARTStartDate is strictly AFTER the baseline date.
        // Facilities with no baseline row fall back to counting all history
        // (COALESCE to '1900-01-01' makes the >\ condition always true).
        var mainSql = $"""
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                SUM(CASE WHEN p.ARTStartDate > COALESCE(bl.BaselineDate, CAST('1900-01-01' AS DATE))
                          AND p.ARTStartDate <= @PrevEnd
                         THEN 1 ELSE 0 END)                                    AS PrevCumul,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                         THEN 1 ELSE 0 END)                                    AS NewInPeriod,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                          AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                    AS Breastfeeding,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                          AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                    AS Pregnant
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf   ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN FacilityBaselineT bl ON bl.HealthFacilityID = hf.HealthFacilityID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        var ctxSql = $"""
            SELECT p.CPTDrugID, p.SexID, COUNT(*) AS Total
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN FacilityBaselineT bl ON bl.HealthFacilityID = hf.HealthFacilityID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.CPTDrugID   IN (1, 2)
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate > COALESCE(bl.BaselineDate, CAST('1900-01-01' AS DATE))
              AND  p.ARTStartDate <= @PeriodEnd
              {geoAnd}
            GROUP  BY p.CPTDrugID, p.SexID
            """;

        // Section (ii): new patients started on CTX/Dapsone within the reporting period
        // Includes Pregnant and Breastfeeding subsets (female only) matching the main query logic.
        var ctxNewSql = $"""
            SELECT p.CPTDrugID, p.SexID,
                   COUNT(*) AS Total,
                   SUM(CASE WHEN p.BreastfeedingID = 2               THEN 1 ELSE 0 END) AS Breastfeeding,
                   SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL        THEN 1 ELSE 0 END) AS Pregnant
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.CPTDrugID   IN (1, 2)
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
              {geoAnd}
            GROUP  BY p.CPTDrugID, p.SexID
            """;

        // ── Page 2: Current on ART — 1st/2nd line by age group × sex ────
        // Patients whose last follow-up on or before period end is "On ART"
        // (FollowUpStatusID = 1), plus patients with no follow-up yet
        // (started ART <= period end, assumed still active, defaulted to 1st-line).
        var currentOnArtSql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    fu.RegimenID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COALESCE(r.RegimenCategoryID, 1) AS RegimenCatID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN RegimenARTT     r  ON r.RegimenID     = lv.RegimenID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate <= @PeriodEnd
              AND  (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase},
                      COALESCE(r.RegimenCategoryID, 1)
            ORDER  BY AgeGrp, p.SexID
            """;

        // ── Page 2: TB status at last visit in the reporting period ──────
        // For each patient who had a follow-up visit during the period,
        // use their LAST visit's TBStatusID to populate rows 41–45.
        var tbStatusSql = $"""
            WITH LastVisitInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.TBStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
            )
            SELECT
                p.SexID,
                lv.TBStatusID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              {geoAnd}
            GROUP  BY p.SexID, lv.TBStatusID
            """;

        // ── Page 2 row 46: TB treatment started in the reporting period ──
        // Counts patients with TBRxStartDate within the period.
        var tbRxStartedSql = $"""
            SELECT
                p.SexID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.TBRxStartDate BETWEEN @PeriodStart AND @PeriodEnd
              {geoAnd}
            GROUP  BY p.SexID
            """;

        // ── Page 2 rows 95–96: CTX / Dapsone for current patients ────────
        // Current = same definition as currentOnArtSql; disaggregated by
        // 4-bracket age group and sex.
        var ctxDapsonePage2Sql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeBracketCase} AS AgeBracket,
                p.CPTDrugID,
                COUNT(*) AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate <= @PeriodEnd
              AND  p.CPTDrugID   IN (1, 2)
              AND  (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeBracketCase},
                      p.CPTDrugID
            """;

        // ── Page 2 rows 97–98: LTFU and Deaths during the reporting period
        // Patients whose LAST follow-up visit in the period shows status
        // 5 (LTFU) or 2 (Dead).
        var ltfuDeathsSql = $"""
            WITH LastVisitInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeBracketCase} AS AgeBracket,
                lv.FollowUpStatusID,
                COUNT(*) AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  lv.FollowUpStatusID IN (2, 5)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeBracketCase},
                      lv.FollowUpStatusID
            """;

        // ── Page 2 rows 51–93: per-regimen counts ─────────────────────────
        // Current-on-ART patients (last follow-up ≤ period end, status = 1)
        // who have a specific RegimenID recorded, grouped by RegimenCode ×
        // 4-bracket age group.  Patients with no follow-up or no regimen are
        // excluded — they cannot be assigned to a specific regimen row.
        // Columns: B=<10 total, D=10-14 total, F=15-49 total, H=50+ total,
        //          K=Breastfeeding total, L=Pregnant total.
        // (B:C, D:E, F:G, H:I are merged pairs in the template; only B,D,F,H
        //  are the active input cells; J = SUM(B:I) is a formula — not written.)
        var perRegimenSql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    fu.RegimenID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                LOWER(RTRIM(LTRIM(r.RegimenCode)))                                    AS RegimenCode,
                p.SexID,
                {AgeBracketCase}                                                       AS AgeBracket,
                COUNT(*)                                                               AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                           AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                           AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            JOIN   RegimenARTT        r  ON r.RegimenID     = lv.RegimenID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted           = 0
              AND  p.IsTransferIn      = 0
              AND  p.ARTStartDate      IS NOT NULL
              AND  p.ARTStartDate      <= @PeriodEnd
              AND  lv.FollowUpStatusID = 1
              {geoAnd}
            GROUP  BY LOWER(RTRIM(LTRIM(r.RegimenCode))),
                      p.SexID,
                      {AgeBracketCase}
            ORDER  BY RegimenCode
            """;

        // ── Page 3: Viral Load — samples / results by age group × sex ───
        // One row per patient using their LATEST numeric VL visit in the
        // reporting period.  Non-numeric ViralLoad values are excluded via
        // TRY_CAST.  Samples = all numeric VL visits = Suppressed + Unsuppressed.
        var vlSql = $"""
            WITH LatestVLInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    TRY_CAST(fu.ViralLoad AS BIGINT) AS VLValue,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted      = 0
                  AND fu.VisitDate    BETWEEN @PeriodStart AND @PeriodEnd
                  AND fu.ViralLoad    IS NOT NULL
                  AND fu.ViralLoad    != ''
                  AND TRY_CAST(fu.ViralLoad AS BIGINT) IS NOT NULL
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COUNT(*)                                                                     AS Samples,
                SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                                  AS SamplesPreg,
                SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                                  AS SamplesBF,
                SUM(CASE WHEN lv.VLValue < 1000 THEN 1 ELSE 0 END)                          AS Suppressed,
                SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                              AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)           AS SuppressedPreg,
                SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                              AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                  AS SuppressedBF,
                SUM(CASE WHEN lv.VLValue >= 1000 THEN 1 ELSE 0 END)                         AS Unsuppressed,
                SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                              AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)           AS UnsuppressedPreg,
                SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                              AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                  AS UnsuppressedBF
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf  ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LatestVLInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        // ── Page 3: High VL clients traced ───────────────────────────────
        // Patients who had VL ≥ 1000 in the period AND had at least one
        // subsequent follow-up visit after the high-VL visit.
        var vlTracedSql = $"""
            WITH HighVLInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.VisitDate AS HighVLDate,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted   = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
                  AND TRY_CAST(fu.ViralLoad AS BIGINT) >= 1000
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COUNT(*)                                                              AS Traced,
                SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf  ON hf.HealthFacilityID = p.NearestHFID
            JOIN   HighVLInPeriod  hv  ON hv.PtDetailsTID = p.PtDetailsTID AND hv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  EXISTS (
                       SELECT 1 FROM PtFollowUpARTT fu2
                       WHERE  fu2.PtDetailsTID = p.PtDetailsTID
                         AND  fu2.Deleted      = 0
                         AND  fu2.VisitDate    > hv.HighVLDate
                   )
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        // ── Baseline aggregate SQL ───────────────────────────────────────
        // Sum up baseline counts for all selected facilities whose
        // BaselineDate is strictly BEFORE the reporting period start.
        // Only runs when specific facility IDs are provided.
        string? baselineSql = null;
        if (cleanFacIds.Length > 0)
        {
            var baseFacParams = cleanFacIds.Select((_, i) => $"@BaseFacId{i}");
            baselineSql = $"""
                SELECT
                    SUM(AgeGrp0_M)  AS AG0M,  SUM(AgeGrp0_F)  AS AG0F,
                    SUM(AgeGrp1_M)  AS AG1M,  SUM(AgeGrp1_F)  AS AG1F,
                    SUM(AgeGrp2_M)  AS AG2M,  SUM(AgeGrp2_F)  AS AG2F,
                    SUM(AgeGrp3_M)  AS AG3M,  SUM(AgeGrp3_F)  AS AG3F,
                    SUM(AgeGrp4_M)  AS AG4M,  SUM(AgeGrp4_F)  AS AG4F,
                    SUM(AgeGrp5_M)  AS AG5M,  SUM(AgeGrp5_F)  AS AG5F,
                    SUM(AgeGrp6_M)  AS AG6M,  SUM(AgeGrp6_F)  AS AG6F,
                    SUM(AgeGrp7_M)  AS AG7M,  SUM(AgeGrp7_F)  AS AG7F,
                    SUM(AgeGrp8_M)  AS AG8M,  SUM(AgeGrp8_F)  AS AG8F,
                    SUM(AgeGrp9_M)  AS AG9M,  SUM(AgeGrp9_F)  AS AG9F,
                    SUM(AgeGrp10_M) AS AG10M, SUM(AgeGrp10_F) AS AG10F,
                    SUM(AgeGrp11_M) AS AG11M, SUM(AgeGrp11_F) AS AG11F,
                    SUM(CTXTotal_M)     AS CTXTotalM,
                    SUM(CTXTotal_F)     AS CTXTotalF,
                    SUM(DapsoneTotal_M) AS DapsoneTotalM,
                    SUM(DapsoneTotal_F) AS DapsoneTotalF
                FROM FacilityBaselineT
                WHERE HealthFacilityID IN ({string.Join(", ", baseFacParams)})
                  AND BaselineDate < @PeriodStart
                """;
        }

        // ── Data accumulators ────────────────────────────────────────────
        // [ageGroup 0–11][0=Male 1=Female]
        int[,] prevCumul      = new int[12, 2];
        int[,] newInPeriod    = new int[12, 2];
        int[,] newPregnant    = new int[12, 2];
        int[,] newBreastfeed  = new int[12, 2];
        int ctxMale          = 0;
        int ctxFemale         = 0;
        int dapsoneMale       = 0;
        int dapsoneFemale     = 0;
        int ctxNewMale           = 0;
        int ctxNewFemale         = 0;
        int ctxNewPregnant       = 0;
        int ctxNewBreastfeed     = 0;
        int dapsoneNewMale       = 0;
        int dapsoneNewFemale     = 0;
        int dapsoneNewPregnant   = 0;
        int dapsoneNewBreastfeed = 0;

        // ── Page 2 accumulators ──────────────────────────────────────────
        // Section A: current on ART by 1st/2nd line, age group [0–11], sex [0=M, 1=F]
        int[,] art1stCount = new int[12, 2];
        int[,] art2ndCount = new int[12, 2];
        int[]  art1stPreg  = new int[12];   // female subsets
        int[]  art1stBF    = new int[12];
        int[]  art2ndPreg  = new int[12];
        int[]  art2ndBF    = new int[12];

        // TB status rows 41–45: [TBStatusID 1–5][0=M, 1=F, 2=Preg, 3=BF]
        int[,] tbStatusCount = new int[6, 4];
        int tbRxM = 0, tbRxF = 0, tbRxPreg = 0, tbRxBF = 0;

        // Summary rows 95–98: [ageBracket 0–3 (<10,10-14,15-49,50+)][0=M, 1=F]
        int[,] ctxPage2     = new int[4, 2];
        int[,] dapsPage2    = new int[4, 2];
        int[,] ltfuPage2    = new int[4, 2];
        int[,] deathsPage2  = new int[4, 2];
        // K/L totals for rows 95–98 (Breastfeeding, Pregnant — female subsets)
        int ctxBF = 0,    ctxPreg = 0;
        int dapsBF = 0,   dapsPreg = 0;
        int ltfuBF = 0,   ltfuPreg = 0;
        int deathsBF = 0, deathsPreg = 0;

        // Per-regimen rows 51–93: keyed by RegimenCode (lower-case, trimmed).
        // [ageBracket 0–3][sex 0=M 1=F] = count; separate totals for BF and Pregnant.
        var regimenAgeCounts = new Dictionary<string, int[,]>(StringComparer.OrdinalIgnoreCase);
        var regimenPregTotals = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var regimenBFTotals   = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        // ── Page 3 VL accumulators ───────────────────────────────────────
        // [ageGrp 0–11][0=Male, 1=Female]
        int[,] vlSamples     = new int[12, 2];
        int[]  vlSamplesPreg = new int[12];
        int[]  vlSamplesBF   = new int[12];
        int[,] vlSupp        = new int[12, 2];
        int[]  vlSuppPreg    = new int[12];
        int[]  vlSuppBF      = new int[12];
        int[,] vlUnsupp      = new int[12, 2];
        int[]  vlUnsuppPreg  = new int[12];
        int[]  vlUnsuppBF    = new int[12];
        int[,] vlTraced      = new int[12, 2];
        int[]  vlTracedPreg  = new int[12];
        int[]  vlTracedBF    = new int[12];

        string facilityLabel  = "All Facilities";
        string geoFilePrefix  = "National";

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // ── Resolve the facility label for the report header ─────────
            (facilityLabel, geoFilePrefix) = await ResolveFacilityLabel(conn, cleanFacIds, isNgo, userSubRecId);

            // ── Main patient data query ──────────────────────────────────
            await using (var cmd = new SqlCommand(mainSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp  = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int prev    = rdr.GetInt32(rdr.GetOrdinal("PrevCumul"));
                    int newPt   = rdr.GetInt32(rdr.GetOrdinal("NewInPeriod"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));

                    // SexID: 1 = Male, 2 = Female; map to index 0/1
                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;

                    prevCumul[ageGrp, si]     += prev;
                    newInPeriod[ageGrp, si]   += newPt;
                    newPregnant[ageGrp, si]   += preg;
                    newBreastfeed[ageGrp, si] += bf;
                }
            }

            // ── CTX / Dapsone counts — cumulative (section i) ────────────
            await using (var cmd = new SqlCommand(ctxSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int drugId = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total  = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    bool isMale = sexId != 2;
                    if      (drugId == 1 && isMale)  ctxMale      += total;
                    else if (drugId == 1 && !isMale) ctxFemale    += total;
                    else if (drugId == 2 && isMale)  dapsoneMale  += total;
                    else if (drugId == 2 && !isMale) dapsoneFemale+= total;
                }
            }

            // ── CTX / Dapsone counts — new in period (section ii) ────────
            await using (var cmd = new SqlCommand(ctxNewSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int drugId  = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    bool isMale = sexId != 2;
                    if (drugId == 1)
                    {
                        if (isMale) ctxNewMale       += total;
                        else        { ctxNewFemale    += total; ctxNewPregnant   += preg; ctxNewBreastfeed   += bf; }
                    }
                    else if (drugId == 2)
                    {
                        if (isMale) dapsoneNewMale   += total;
                        else        { dapsoneNewFemale += total; dapsoneNewPregnant += preg; dapsoneNewBreastfeed += bf; }
                    }
                }
            }

            // ── Page 2: Current on ART by 1st/2nd line × age group × sex ─
            await using (var cmd = new SqlCommand(currentOnArtSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp  = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int catId   = rdr.GetInt32(rdr.GetOrdinal("RegimenCatID"));
                    int total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;

                    // catId 1=Adult1st, 3=Child1st → 1st line; 2=Adult2nd, 4=Child2nd → 2nd line
                    bool is1st = catId != 2 && catId != 4;
                    if (is1st)
                    {
                        art1stCount[ageGrp, si] += total;
                        if (si == 1) { art1stPreg[ageGrp] += preg; art1stBF[ageGrp] += bf; }
                    }
                    else
                    {
                        art2ndCount[ageGrp, si] += total;
                        if (si == 1) { art2ndPreg[ageGrp] += preg; art2ndBF[ageGrp] += bf; }
                    }
                }
            }

            // ── Page 2: TB status at last visit in the period (rows 41–45) ─
            await using (var cmd = new SqlCommand(tbStatusSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int tbId   = rdr.GetInt32(rdr.GetOrdinal("TBStatusID"));
                    int total  = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg   = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf     = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (tbId < 1 || tbId > 5) continue;

                    tbStatusCount[tbId, si] += total;
                    if (si == 1) { tbStatusCount[tbId, 2] += preg; tbStatusCount[tbId, 3] += bf; }
                }
            }

            // ── Page 2 row 46: TB treatment started in the period ─────────
            await using (var cmd = new SqlCommand(tbRxStartedSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg  = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf    = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    if (sexId != 2) tbRxM += total;
                    else            { tbRxF += total; tbRxPreg += preg; tbRxBF += bf; }
                }
            }

            // ── Page 2 rows 95–96: CTX / Dapsone for current patients ─────
            await using (var cmd = new SqlCommand(ctxDapsonePage2Sql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int bracket = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int drugId  = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;

                    if (drugId == 1)
                    {
                        ctxPage2[bracket, si] += total;
                        ctxPreg += preg;
                        ctxBF   += bf;
                    }
                    else if (drugId == 2)
                    {
                        dapsPage2[bracket, si] += total;
                        dapsPreg += preg;
                        dapsBF   += bf;
                    }
                }
            }

            // ── Page 2 rows 97–98: LTFU and Deaths during the period ──────
            await using (var cmd = new SqlCommand(ltfuDeathsSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId    = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int bracket  = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int statusId = rdr.GetInt32(rdr.GetOrdinal("FollowUpStatusID"));
                    int total    = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg     = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf       = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;

                    if (statusId == 5)
                    {
                        ltfuPage2[bracket, si] += total;
                        ltfuPreg += preg;
                        ltfuBF   += bf;
                    }
                    else if (statusId == 2)
                    {
                        deathsPage2[bracket, si] += total;
                        deathsPreg += preg;
                        deathsBF   += bf;
                    }
                }
            }

            // ── Page 2 rows 51–93: per-regimen breakdown ─────────────────
            await using (var cmd = new SqlCommand(perRegimenSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    string code    = rdr.GetString(rdr.GetOrdinal("RegimenCode"));
                    int    sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int    bracket = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int    total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int    preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int    bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;

                    if (!regimenAgeCounts.TryGetValue(code, out var counts))
                    {
                        counts = new int[4, 2];
                        regimenAgeCounts[code] = counts;
                    }
                    counts[bracket, si] += total;

                    regimenPregTotals[code] = (regimenPregTotals.TryGetValue(code, out var ep) ? ep : 0) + preg;
                    regimenBFTotals[code]   = (regimenBFTotals.TryGetValue(code, out var eb)   ? eb : 0) + bf;
                }
            }

            // ── Page 3: Viral Load — samples and results ──────────────────
            await using (var cmd = new SqlCommand(vlSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId       = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp      = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int samples     = rdr.GetInt32(rdr.GetOrdinal("Samples"));
                    int sampPreg    = rdr.GetInt32(rdr.GetOrdinal("SamplesPreg"));
                    int sampBF      = rdr.GetInt32(rdr.GetOrdinal("SamplesBF"));
                    int supp        = rdr.GetInt32(rdr.GetOrdinal("Suppressed"));
                    int suppPreg    = rdr.GetInt32(rdr.GetOrdinal("SuppressedPreg"));
                    int suppBF      = rdr.GetInt32(rdr.GetOrdinal("SuppressedBF"));
                    int unsupp      = rdr.GetInt32(rdr.GetOrdinal("Unsuppressed"));
                    int unsuppPreg  = rdr.GetInt32(rdr.GetOrdinal("UnsuppressedPreg"));
                    int unsuppBF    = rdr.GetInt32(rdr.GetOrdinal("UnsuppressedBF"));

                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;

                    vlSamples[ageGrp, si]  += samples;
                    vlSupp[ageGrp, si]     += supp;
                    vlUnsupp[ageGrp, si]   += unsupp;
                    if (si == 1)
                    {
                        vlSamplesPreg[ageGrp] += sampPreg;
                        vlSamplesBF[ageGrp]   += sampBF;
                        vlSuppPreg[ageGrp]    += suppPreg;
                        vlSuppBF[ageGrp]      += suppBF;
                        vlUnsuppPreg[ageGrp]  += unsuppPreg;
                        vlUnsuppBF[ageGrp]    += unsuppBF;
                    }
                }
            }

            // ── Page 3: High VL clients traced ────────────────────────────
            await using (var cmd = new SqlCommand(vlTracedSql, conn))
            {
                foreach (var (k, v) in sqlParams)
                    cmd.Parameters.AddWithValue(k, v);

                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int traced = rdr.GetInt32(rdr.GetOrdinal("Traced"));
                    int preg   = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf     = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));

                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;

                    vlTraced[ageGrp, si] += traced;
                    if (si == 1) { vlTracedPreg[ageGrp] += preg; vlTracedBF[ageGrp] += bf; }
                }
            }

            // ── Baseline period validation (blocking) ─────────────────────
            // For single-facility requests, check whether the report period
            // starts before the facility's baseline date.  That would produce
            // an inaccurate report (Section i would be inflated by patients
            // that should only be in the baseline opener).
            if (cleanFacIds.Length == 1)
            {
                const string checkSql = """
                    SELECT b.BaselineDate
                    FROM   FacilityBaselineT b
                    WHERE  b.HealthFacilityID = @CheckFacId
                      AND  b.BaselineDate >= @PeriodStart
                    """;
                await using var chkCmd = new SqlCommand(checkSql, conn);
                chkCmd.Parameters.AddWithValue("@CheckFacId", cleanFacIds[0]);
                chkCmd.Parameters.AddWithValue("@PeriodStart", periodStart);

                var dbDate = await chkCmd.ExecuteScalarAsync();
                if (dbDate is not null and not DBNull)
                {
                    var blDate = DateOnly.FromDateTime((DateTime)dbDate);
                    return UnprocessableEntity(new
                    {
                        error = $"The report period ({periodStart:MMMM yyyy}) starts on or before the " +
                                $"configured baseline date ({blDate:MMMM yyyy}). " +
                                "Please configure an earlier baseline date or choose a later reporting period.",
                        errorCode = "PERIOD_BEFORE_BASELINE",
                        baselineDate = blDate.ToString("yyyy-MM-dd"),
                    });
                }
            }

            // ── Add baseline counts to prevCumul ──────────────────────────
            // Fetch the aggregated baseline figures for all selected facilities
            // whose baseline date is before the report period start, then add
            // them to the counts already computed from the patient records.
            if (baselineSql is not null)
            {
                await using var blCmd = new SqlCommand(baselineSql, conn);

                // @PeriodStart is already in sqlParams but the baseline query
                // uses its own facility parameters to avoid cross-contamination.
                blCmd.Parameters.AddWithValue("@PeriodStart", periodStart);
                for (int i = 0; i < cleanFacIds.Length; i++)
                    blCmd.Parameters.AddWithValue($"@BaseFacId{i}", cleanFacIds[i]);

                await using var blRdr = await blCmd.ExecuteReaderAsync();
                if (await blRdr.ReadAsync() && !blRdr.IsDBNull(0))
                {
                    // Alias order: AG0M, AG0F, AG1M, AG1F, ..., AG11M, AG11F, CTXTotal, DapsoneTotal
                    // Total = 24 count columns + 2 totals = 26 columns (indices 0..25)
                    string[] aliases =
                    [
                        "AG0M","AG0F","AG1M","AG1F","AG2M","AG2F","AG3M","AG3F",
                        "AG4M","AG4F","AG5M","AG5F","AG6M","AG6F","AG7M","AG7F",
                        "AG8M","AG8F","AG9M","AG9F","AG10M","AG10F","AG11M","AG11F",
                        "CTXTotalM","CTXTotalF","DapsoneTotalM","DapsoneTotalF"
                    ];
                    for (int ag = 0; ag <= 11; ag++)
                    {
                        int blMale   = blRdr.IsDBNull(blRdr.GetOrdinal(aliases[ag * 2]))
                                       ? 0 : blRdr.GetInt32(blRdr.GetOrdinal(aliases[ag * 2]));
                        int blFemale = blRdr.IsDBNull(blRdr.GetOrdinal(aliases[ag * 2 + 1]))
                                       ? 0 : blRdr.GetInt32(blRdr.GetOrdinal(aliases[ag * 2 + 1]));
                        prevCumul[ag, 0] += blMale;
                        prevCumul[ag, 1] += blFemale;
                    }
                    int blCtxMOrd  = blRdr.GetOrdinal("CTXTotalM");
                    int blCtxFOrd  = blRdr.GetOrdinal("CTXTotalF");
                    int blDapMOrd  = blRdr.GetOrdinal("DapsoneTotalM");
                    int blDapFOrd  = blRdr.GetOrdinal("DapsoneTotalF");
                    if (!blRdr.IsDBNull(blCtxMOrd))  ctxMale       += blRdr.GetInt32(blCtxMOrd);
                    if (!blRdr.IsDBNull(blCtxFOrd))  ctxFemale     += blRdr.GetInt32(blCtxFOrd);
                    if (!blRdr.IsDBNull(blDapMOrd))  dapsoneMale   += blRdr.GetInt32(blDapMOrd);
                    if (!blRdr.IsDBNull(blDapFOrd))  dapsoneFemale += blRdr.GetInt32(blDapFOrd);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating ART Report for {Start}-{End}.", startDate, endDate);
            return StatusCode(500, new { error = "Report generation failed. Please try again.", detail = ex.Message });
        }

        // ── Load template and fill cells ─────────────────────────────────
        var templatePath = Path.Combine(_env.ContentRootPath, "Templates", "ART_Monthly_Report_Form_Rev.xlsx");
        if (!System.IO.File.Exists(templatePath))
        {
            _logger.LogError("ART Monthly Report template not found at {Path}.", templatePath);
            return StatusCode(500, new { error = "Report template file is missing on the server." });
        }

        try
        {
            await using var templateStream = new FileStream(templatePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var workbook = new XLWorkbook(templateStream);
            var ws = workbook.Worksheet("Page 1");

            // ── Header row 7 ─────────────────────────────────────────────
            ws.Cell("B7").Value = facilityLabel;
            ws.Cell("I7").Value = periodLabel;

            // ── Data rows 13–24 (age groups 0–11) ─────────────────────────
            // Input columns: B=Section-i Male, C=Section-i Female,
            //                E=Section-ii Male, F=Section-ii Female,
            //                G=Section-ii Pregnant, H=Section-ii Breastfeeding
            // Formula columns D, I, J, K, L are left intact to auto-calculate.
            for (int ag = 0; ag <= 11; ag++)
            {
                int row = 13 + ag;
                ws.Cell(row, 2).Value = prevCumul[ag, 0];      // B: Section i Male
                ws.Cell(row, 3).Value = prevCumul[ag, 1];      // C: Section i Female
                ws.Cell(row, 5).Value = newInPeriod[ag, 0];    // E: Section ii Male
                ws.Cell(row, 6).Value = newInPeriod[ag, 1];    // F: Section ii Female
                ws.Cell(row, 7).Value = newPregnant[ag, 1];    // G: Section ii Pregnant (female)
                ws.Cell(row, 8).Value = newBreastfeed[ag, 1];  // H: Section ii Breastfeeding (female)
            }

            // ── CTX / Dapsone totals (rows 26–27) ────────────────────────
            // Section (i) — cumulative
            ws.Cell("B26").Value = ctxMale;
            ws.Cell("C26").Value = ctxFemale;
            ws.Cell("B27").Value = dapsoneMale;
            ws.Cell("C27").Value = dapsoneFemale;
            // Section (ii) — new in reporting period
            ws.Cell("E26").Value = ctxNewMale;
            ws.Cell("F26").Value = ctxNewFemale;
            ws.Cell("G26").Value = ctxNewPregnant;
            ws.Cell("H26").Value = ctxNewBreastfeed;
            ws.Cell("E27").Value = dapsoneNewMale;
            ws.Cell("F27").Value = dapsoneNewFemale;
            ws.Cell("G27").Value = dapsoneNewPregnant;
            ws.Cell("H27").Value = dapsoneNewBreastfeed;

            // ── Page 2 — fill cells ───────────────────────────────────────
            var ws2 = workbook.Worksheet("Page 2");

            // Header row 5
            ws2.Cell("B5").Value = facilityLabel;
            ws2.Cell("J5").Value = periodLabel;

            // Section A: 1st-line rows 10–21 (age groups 0–11)
            // Input columns: D=Male, F=Female, H=Pregnant, J=Breastfeeding
            // L=D+F is a formula — leave intact.
            for (int ag = 0; ag <= 11; ag++)
            {
                int r1 = 10 + ag;
                ws2.Cell(r1, 4).Value  = art1stCount[ag, 0];  // D: Male
                ws2.Cell(r1, 6).Value  = art1stCount[ag, 1];  // F: Female
                ws2.Cell(r1, 8).Value  = art1stPreg[ag];       // H: Pregnant
                ws2.Cell(r1, 10).Value = art1stBF[ag];          // J: Breastfeeding
            }

            // Section A: 2nd-line rows 25–36 (age groups 0–11)
            for (int ag = 0; ag <= 11; ag++)
            {
                int r2 = 25 + ag;
                ws2.Cell(r2, 4).Value  = art2ndCount[ag, 0];
                ws2.Cell(r2, 6).Value  = art2ndCount[ag, 1];
                ws2.Cell(r2, 8).Value  = art2ndPreg[ag];
                ws2.Cell(r2, 10).Value = art2ndBF[ag];
            }

            // TB status rows 41–45 (TBStatusID 1=No signs … 5=ND)
            // and row 46 (TB treatment started in period)
            // Columns: D=Male, F=Female, H=Pregnant, J=Breastfeeding
            int[] tbStatusRows = { 41, 42, 43, 44, 45 };
            for (int i = 0; i < tbStatusRows.Length; i++)
            {
                int tbId  = i + 1;
                int rowTb = tbStatusRows[i];
                ws2.Cell(rowTb, 4).Value  = tbStatusCount[tbId, 0];
                ws2.Cell(rowTb, 6).Value  = tbStatusCount[tbId, 1];
                ws2.Cell(rowTb, 8).Value  = tbStatusCount[tbId, 2];
                ws2.Cell(rowTb, 10).Value = tbStatusCount[tbId, 3];
            }
            ws2.Cell(46, 4).Value  = tbRxM;
            ws2.Cell(46, 6).Value  = tbRxF;
            ws2.Cell(46, 8).Value  = tbRxPreg;
            ws2.Cell(46, 10).Value = tbRxBF;

            // Summary rows 95–98 (CTX, Dapsone, LTFU, Deaths)
            // Columns B–I = age bracket × sex:
            //   B=<10M(2), C=<10F(3), D=10-14M(4), E=10-14F(5),
            //   F=15-49M(6), G=15-49F(7), H=50+M(8), I=50+F(9)
            // J=SUM(B:I) is a formula — leave intact.
            for (int b = 0; b < 4; b++)
            {
                int colM = 2 + b * 2;
                int colF = 3 + b * 2;
                ws2.Cell(95, colM).Value = ctxPage2[b, 0];
                ws2.Cell(95, colF).Value = ctxPage2[b, 1];
                ws2.Cell(96, colM).Value = dapsPage2[b, 0];
                ws2.Cell(96, colF).Value = dapsPage2[b, 1];
                ws2.Cell(97, colM).Value = ltfuPage2[b, 0];
                ws2.Cell(97, colF).Value = ltfuPage2[b, 1];
                ws2.Cell(98, colM).Value = deathsPage2[b, 0];
                ws2.Cell(98, colF).Value = deathsPage2[b, 1];
            }
            // K(11)=Breastfeeding total, L(12)=Pregnant total for rows 95–98
            ws2.Cell(95, 11).Value = ctxBF;    ws2.Cell(95, 12).Value = ctxPreg;
            ws2.Cell(96, 11).Value = dapsBF;   ws2.Cell(96, 12).Value = dapsPreg;
            ws2.Cell(97, 11).Value = ltfuBF;   ws2.Cell(97, 12).Value = ltfuPreg;
            ws2.Cell(98, 11).Value = deathsBF; ws2.Cell(98, 12).Value = deathsPreg;

            // Per-regimen rows 51–93
            // Template columns (merged pairs): B=<10(2), D=10-14(4), F=15-49(6), H=50+(8)
            // J(10) = SUM(B:I) formula — leave intact.
            // K(11) = Breastfeeding total; L(12) = Pregnant total.
            // All rows are always written (0 when no patients match) so cells
            // never appear blank — Excel shows 0 rather than empty.
            // Data rows: 51–59 (Adult 1st), 61–71 (Adult 2nd),
            //            73–83 (Child 1st), 85–93 (Child 2nd).
            // Rows 60, 72, 84 are section headers — skipped automatically
            // because they have no entry in RegimenCodeToRow.
            foreach (var (code, row) in RegimenCodeToRow)
            {
                regimenAgeCounts.TryGetValue(code, out var counts);
                regimenPregTotals.TryGetValue(code, out var pregTotal);
                regimenBFTotals.TryGetValue(code, out var bfTotal);

                // Template: B(2)=<10M, C(3)=<10F, D(4)=10-14M, E(5)=10-14F,
                //           F(6)=15-49M, G(7)=15-49F, H(8)=50+M, I(9)=50+F,
                //           J(10)=Total formula — leave intact,
                //           K(11)=BF total, L(12)=Pregnant total.
                SW(ws2.Cell(row, 2),  counts?[0, 0] ?? 0);  // B: <10 Male
                SW(ws2.Cell(row, 3),  counts?[0, 1] ?? 0);  // C: <10 Female
                SW(ws2.Cell(row, 4),  counts?[1, 0] ?? 0);  // D: 10-14 Male
                SW(ws2.Cell(row, 5),  counts?[1, 1] ?? 0);  // E: 10-14 Female
                SW(ws2.Cell(row, 6),  counts?[2, 0] ?? 0);  // F: 15-49 Male
                SW(ws2.Cell(row, 7),  counts?[2, 1] ?? 0);  // G: 15-49 Female
                SW(ws2.Cell(row, 8),  counts?[3, 0] ?? 0);  // H: 50+ Male
                SW(ws2.Cell(row, 9),  counts?[3, 1] ?? 0);  // I: 50+ Female
                SW(ws2.Cell(row, 11), bfTotal);               // K: BF total
                SW(ws2.Cell(row, 12), pregTotal);             // L: Pregnant total
            }

            // ── Page 3 — fill cells ───────────────────────────────────────
            var ws3 = workbook.Worksheet("Page 3");

            // Header row 5
            ws3.Cell("B5").Value = facilityLabel;
            ws3.Cell("T5").Value = periodLabel;

            // Data rows 11–22 (age groups 0–11)
            // Columns:
            //   B=Samples M(2),  C=Samples F(3),  D=Samples Preg(4), E=Samples BF(5)
            //   F=Total formula — skip
            //   G=Supp M(7),     H=Supp F(8),     I=Supp Preg(9),   J=Supp BF(10)
            //   K=Total formula — skip
            //   L=Unsupp M(12),  M=Unsupp F(13),  N=Unsupp Preg(14),O=Unsupp BF(15)
            //   P=Total formula — skip
            //   Q=Traced M(17),  R=Traced F(18),  S=Traced Preg(19),T=Traced BF(20)
            //   U=Total formula — skip
            for (int ag = 0; ag <= 11; ag++)
            {
                int r = 11 + ag;
                ws3.Cell(r,  2).Value = vlSamples[ag, 0];    // B: Samples Male
                ws3.Cell(r,  3).Value = vlSamples[ag, 1];    // C: Samples Female
                ws3.Cell(r,  4).Value = vlSamplesPreg[ag];    // D: Samples Pregnant
                ws3.Cell(r,  5).Value = vlSamplesBF[ag];      // E: Samples BF
                ws3.Cell(r,  7).Value = vlSupp[ag, 0];        // G: <1000 Male
                ws3.Cell(r,  8).Value = vlSupp[ag, 1];        // H: <1000 Female
                ws3.Cell(r,  9).Value = vlSuppPreg[ag];       // I: <1000 Pregnant
                ws3.Cell(r, 10).Value = vlSuppBF[ag];          // J: <1000 BF
                ws3.Cell(r, 12).Value = vlUnsupp[ag, 0];      // L: ≥1000 Male
                ws3.Cell(r, 13).Value = vlUnsupp[ag, 1];      // M: ≥1000 Female
                ws3.Cell(r, 14).Value = vlUnsuppPreg[ag];     // N: ≥1000 Pregnant
                ws3.Cell(r, 15).Value = vlUnsuppBF[ag];        // O: ≥1000 BF
                ws3.Cell(r, 17).Value = vlTraced[ag, 0];      // Q: Traced Male
                ws3.Cell(r, 18).Value = vlTraced[ag, 1];      // R: Traced Female
                ws3.Cell(r, 19).Value = vlTracedPreg[ag];     // S: Traced Pregnant
                ws3.Cell(r, 20).Value = vlTracedBF[ag];        // T: Traced BF
            }

            // ── Stream the result to the caller ──────────────────────────
            var outputStream = new MemoryStream();
            workbook.SaveAs(outputStream);
            outputStream.Position = 0;

            var fileName = $"{geoFilePrefix}_ART_Report_{filePeriod}_SV.xlsx";
            return File(outputStream,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                fileName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error filling ART Monthly Report template.");
            return StatusCode(500, new { error = "Failed to produce the report file.", detail = ex.Message });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Derive a human-readable period label from the date range.
    //  Written into the Excel header cell I7.
    //  No client input is used — label is computed server-side.
    // ──────────────────────────────────────────────────────────────────────
    private static string DerivePeriodLabel(DateOnly start, DateOnly end)
    {
        int y = start.Year;
        if (start == new DateOnly(y, 1, 1) && end == new DateOnly(y, 12, 31))
            return y.ToString();
        if (start == new DateOnly(y, 1, 1) && end == new DateOnly(y, 6, 30))
            return $"Semester 1 {y}";
        if (start == new DateOnly(y, 7, 1) && end == new DateOnly(y, 12, 31))
            return $"Semester 2 {y}";
        if (start == new DateOnly(y, 1,  1) && end == new DateOnly(y, 3, 31))
            return $"Q1 {y}";
        if (start == new DateOnly(y, 4,  1) && end == new DateOnly(y, 6, 30))
            return $"Q2 {y}";
        if (start == new DateOnly(y, 7,  1) && end == new DateOnly(y, 9, 30))
            return $"Q3 {y}";
        if (start == new DateOnly(y, 10, 1) && end == new DateOnly(y, 12, 31))
            return $"Q4 {y}";
        if (start.Year == end.Year && start.Month == end.Month)
            return $"{MonthNames[start.Month]} {start.Year}";
        // Custom range fallback
        return $"{start:dd MMM yyyy} – {end:dd MMM yyyy}";
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Derive a file-name-safe period token from the date range.
    //  Used in the downloaded Excel filename.
    // ──────────────────────────────────────────────────────────────────────
    private static string DeriveFilePeriod(DateOnly start, DateOnly end)
    {
        int y = start.Year;
        if (start == new DateOnly(y, 1, 1) && end == new DateOnly(y, 12, 31))
            return $"Annual_{y}";
        if (start == new DateOnly(y, 1, 1) && end == new DateOnly(y, 6, 30))
            return $"Sem1_{y}";
        if (start == new DateOnly(y, 7, 1) && end == new DateOnly(y, 12, 31))
            return $"Sem2_{y}";
        if (start == new DateOnly(y, 1,  1) && end == new DateOnly(y, 3, 31))
            return $"Q1_{y}";
        if (start == new DateOnly(y, 4,  1) && end == new DateOnly(y, 6, 30))
            return $"Q2_{y}";
        if (start == new DateOnly(y, 7,  1) && end == new DateOnly(y, 9, 30))
            return $"Q3_{y}";
        if (start == new DateOnly(y, 10, 1) && end == new DateOnly(y, 12, 31))
            return $"Q4_{y}";
        if (start.Year == end.Year && start.Month == end.Month)
            return $"{MonthNames[start.Month]}_{start.Year}";
        return $"{start:yyyyMMdd}_{end:yyyyMMdd}";
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Helper: build a human-readable facility label (for the report header)
    //  and a sanitized file prefix (for the download filename).
    //  File prefix examples:
    //    facility  → "Torit_State_Hospital"
    //    county    → "Torit"
    //    state     → "Eastern_Equatoria_State"
    //    NGO       → "NGO_Supported"
    //    national  → "National"
    // ──────────────────────────────────────────────────────────────────────
    private static async Task<(string Label, string FilePrefix)> ResolveFacilityLabel(
        SqlConnection conn,
        int[] facilityIds,
        bool isNgo, int userSubRecId)
    {
        if (facilityIds.Length == 1)
        {
            await using var cmd = new SqlCommand(
                "SELECT HealthFacility FROM HealthFacilityT WHERE HealthFacilityID = @Id", conn);
            cmd.Parameters.AddWithValue("@Id", facilityIds[0]);
            var name = (await cmd.ExecuteScalarAsync() as string)?.Trim() ?? "Unknown Facility";
            return (name, SanitizeForFileName(name));
        }
        if (facilityIds.Length > 1)
        {
            return ($"Multiple Facilities ({facilityIds.Length} selected)",
                    $"Multi_{facilityIds.Length}_Facilities");
        }
        // No specific selection — label based on scope
        if (isNgo && userSubRecId > 0)
        {
            await using var cmd = new SqlCommand(
                "SELECT SubRec FROM SubRecT WHERE SubRecID = @Id", conn);
            cmd.Parameters.AddWithValue("@Id", userSubRecId);
            var name = (await cmd.ExecuteScalarAsync() as string)?.Trim() ?? "NGO";
            return ("All NGO-Supported Facilities", SanitizeForFileName(name));
        }

        return ("All Facilities (National)", "South_Sudan");
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Sanitize a name for use as part of a filename:
    //  letters/digits kept as-is; spaces and hyphens become underscores;
    //  all other characters are dropped.
    // ──────────────────────────────────────────────────────────────────────
    private static string SanitizeForFileName(string name)
    {
        var sb = new System.Text.StringBuilder();
        foreach (char c in name.Trim())
        {
            if (char.IsLetterOrDigit(c))      sb.Append(c);
            else if (c == ' ' || c == '-')    sb.Append('_');
        }
        return sb.ToString().Trim('_');
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/art-monthly-progress
    //      Same parameters as art-monthly.
    //
    //  Streams Server-Sent Events as each SQL query completes so the client
    //  can drive a real progress bar.  On completion a download token is
    //  stored in IMemoryCache (5-minute TTL) and emitted in the final event.
    //  The client then calls art-monthly-download?token=<token> to retrieve
    //  the finished Excel file.
    //
    //  SECURITY: All auth / scope / SQL-injection protections are identical
    //  to the art-monthly endpoint.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("art-monthly-progress")]
    public async Task ArtMonthlyProgress(
        [FromQuery] string startDate,
        [FromQuery] string endDate,
        [FromQuery] int[]? facilityIds = null)
    {
        var ct = HttpContext.RequestAborted;

        // ── Input validation — return normal HTTP errors before SSE starts ──
        if (!DateOnly.TryParse(startDate, out var periodStartDate))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "startDate must be a valid date (yyyy-MM-dd)." }); return; }
        if (!DateOnly.TryParse(endDate, out var periodEndDate))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "endDate must be a valid date (yyyy-MM-dd)." }); return; }
        if (periodEndDate < periodStartDate)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "endDate must be on or after startDate." }); return; }
        if (periodStartDate.Year < 2000 || periodEndDate.Year > 2100)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "Date range is outside the expected bounds (2000–2100)." }); return; }
        if (periodStartDate > DateOnly.FromDateTime(DateTime.Today))
        {
            var fl = DerivePeriodLabel(periodStartDate, periodEndDate);
            Response.StatusCode = 400;
            await Response.WriteAsJsonAsync(new { error = $"The ART report for {fl} is not yet available." });
            return;
        }

        var callerName = User.FindFirstValue(ClaimTypes.Name) ?? User.FindFirstValue("sub") ?? "unknown";
        _logger.LogInformation(
            "ART Report (SSE) requested by {User} — startDate={Start}, endDate={End}, facilityIds=[{FacilityIds}]",
            callerName, startDate, endDate, string.Join(",", facilityIds ?? []));

        // ── JWT scope ────────────────────────────────────────────────────
        bool isNgo      = User.IsInRole("NGO");
        bool isNational = User.IsInRole("National");
        bool isZonal    = User.IsInRole("StateCoordinator");
        bool isDtls     = User.IsInRole("CountySupervisor");

        int.TryParse(User.FindFirstValue("facility_id"),  out var userFacilityId);
        int.TryParse(User.FindFirstValue("state_id"),     out var userStateId);
        int.TryParse(User.FindFirstValue("county_id"),    out var userCountyId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),   out var userSubRecId);
        int.TryParse(User.FindFirstValue("location_id"),  out var userLocationId);

        if (userFacilityId > 0)
            facilityIds = [userFacilityId];

        // ── Date helpers ─────────────────────────────────────────────────
        var periodStart = periodStartDate.ToDateTime(TimeOnly.MinValue);
        var periodEnd   = periodEndDate.ToDateTime(TimeOnly.MinValue);
        var prevEnd     = periodStart.AddDays(-1);
        var periodLabel = DerivePeriodLabel(periodStartDate, periodEndDate);
        var filePeriod  = DeriveFilePeriod(periodStartDate, periodEndDate);

        // ── Geo WHERE clause ─────────────────────────────────────────────
        var cleanFacIds = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var geoConditions = new List<string>();
        var sqlParams = new Dictionary<string, object>
        {
            ["@PeriodStart"] = periodStart,
            ["@PeriodEnd"]   = periodEnd,
            ["@PrevEnd"]     = prevEnd,
        };

        if (cleanFacIds.Length > 0)
        {
            var paramNames = cleanFacIds.Select((_, i) => $"@FacId{i}");
            geoConditions.Add($"hf.HealthFacilityID IN ({string.Join(", ", paramNames)})");
            for (int i = 0; i < cleanFacIds.Length; i++)
                sqlParams[$"@FacId{i}"] = cleanFacIds[i];
        }

        if (isNgo && userSubRecId > 0)
        {
            geoConditions.Add("hf.SubRecID = @SubRecId");
            sqlParams["@SubRecId"] = userSubRecId;
            if ((isZonal || isDtls) && userLocationId > 0)
            {
                geoConditions.Add("hf.LocationID = @LocationId");
                sqlParams["@LocationId"] = userLocationId;
            }
        }

        var geoAnd = geoConditions.Count > 0
            ? "AND " + string.Join(" AND ", geoConditions)
            : string.Empty;

        // ── SQL definitions (identical to ArtMonthly) ────────────────────
        const string AgeGroupCase = """
            CASE
                WHEN p.Age = 0                THEN 0
                WHEN p.Age BETWEEN 1  AND 4   THEN 1
                WHEN p.Age BETWEEN 5  AND 9   THEN 2
                WHEN p.Age BETWEEN 10 AND 14  THEN 3
                WHEN p.Age BETWEEN 15 AND 19  THEN 4
                WHEN p.Age BETWEEN 20 AND 24  THEN 5
                WHEN p.Age BETWEEN 25 AND 29  THEN 6
                WHEN p.Age BETWEEN 30 AND 34  THEN 7
                WHEN p.Age BETWEEN 35 AND 39  THEN 8
                WHEN p.Age BETWEEN 40 AND 44  THEN 9
                WHEN p.Age BETWEEN 45 AND 49  THEN 10
                ELSE 11
            END
            """;

        const string AgeBracketCase = """
            CASE
                WHEN p.Age < 10                THEN 0
                WHEN p.Age BETWEEN 10 AND 14   THEN 1
                WHEN p.Age BETWEEN 15 AND 49   THEN 2
                ELSE 3
            END
            """;

        var mainSql = $"""
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                SUM(CASE WHEN p.ARTStartDate > COALESCE(bl.BaselineDate, CAST('1900-01-01' AS DATE))
                          AND p.ARTStartDate <= @PrevEnd
                         THEN 1 ELSE 0 END)                                    AS PrevCumul,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                         THEN 1 ELSE 0 END)                                    AS NewInPeriod,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                          AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                    AS Breastfeeding,
                SUM(CASE WHEN p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
                          AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                    AS Pregnant
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf   ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN FacilityBaselineT bl ON bl.HealthFacilityID = hf.HealthFacilityID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        var ctxSql = $"""
            SELECT p.CPTDrugID, p.SexID, COUNT(*) AS Total
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN FacilityBaselineT bl ON bl.HealthFacilityID = hf.HealthFacilityID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.CPTDrugID   IN (1, 2)
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate > COALESCE(bl.BaselineDate, CAST('1900-01-01' AS DATE))
              AND  p.ARTStartDate <= @PeriodEnd
              {geoAnd}
            GROUP  BY p.CPTDrugID, p.SexID
            """;

        var ctxNewSql = $"""
            SELECT p.CPTDrugID, p.SexID,
                   COUNT(*) AS Total,
                   SUM(CASE WHEN p.BreastfeedingID = 2               THEN 1 ELSE 0 END) AS Breastfeeding,
                   SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL        THEN 1 ELSE 0 END) AS Pregnant
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.CPTDrugID   IN (1, 2)
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate BETWEEN @PeriodStart AND @PeriodEnd
              {geoAnd}
            GROUP  BY p.CPTDrugID, p.SexID
            """;

        var currentOnArtSql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    fu.RegimenID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COALESCE(r.RegimenCategoryID, 1) AS RegimenCatID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN RegimenARTT     r  ON r.RegimenID     = lv.RegimenID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate <= @PeriodEnd
              AND  (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase},
                      COALESCE(r.RegimenCategoryID, 1)
            ORDER  BY AgeGrp, p.SexID
            """;

        var tbStatusSql = $"""
            WITH LastVisitInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.TBStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
            )
            SELECT
                p.SexID,
                lv.TBStatusID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              {geoAnd}
            GROUP  BY p.SexID, lv.TBStatusID
            """;

        var tbRxStartedSql = $"""
            SELECT
                p.SexID,
                COUNT(*)                                                              AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.TBRxStartDate BETWEEN @PeriodStart AND @PeriodEnd
              {geoAnd}
            GROUP  BY p.SexID
            """;

        var ctxDapsonePage2Sql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeBracketCase} AS AgeBracket,
                p.CPTDrugID,
                COUNT(*) AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  p.ARTStartDate <= @PeriodEnd
              AND  p.CPTDrugID   IN (1, 2)
              AND  (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeBracketCase},
                      p.CPTDrugID
            """;

        var ltfuDeathsSql = $"""
            WITH LastVisitInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
            )
            SELECT
                p.SexID,
                {AgeBracketCase} AS AgeBracket,
                lv.FollowUpStatusID,
                COUNT(*) AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END) AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  p.ARTStartDate IS NOT NULL
              AND  lv.FollowUpStatusID IN (2, 5)
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeBracketCase},
                      lv.FollowUpStatusID
            """;

        var perRegimenSql = $"""
            WITH LastFollowUp AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.FollowUpStatusID,
                    fu.RegimenID,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted = 0
                  AND fu.VisitDate <= @PeriodEnd
            )
            SELECT
                LOWER(RTRIM(LTRIM(r.RegimenCode)))                                    AS RegimenCode,
                p.SexID,
                {AgeBracketCase}                                                       AS AgeBracket,
                COUNT(*)                                                               AS Total,
                SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                           AS Pregnant,
                SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2
                         THEN 1 ELSE 0 END)                                           AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
            LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            JOIN   RegimenARTT        r  ON r.RegimenID     = lv.RegimenID
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted           = 0
              AND  p.IsTransferIn      = 0
              AND  p.ARTStartDate      IS NOT NULL
              AND  p.ARTStartDate      <= @PeriodEnd
              AND  lv.FollowUpStatusID = 1
              {geoAnd}
            GROUP  BY LOWER(RTRIM(LTRIM(r.RegimenCode))),
                      p.SexID,
                      {AgeBracketCase}
            ORDER  BY RegimenCode
            """;

        var vlSql = $"""
            WITH LatestVLInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    TRY_CAST(fu.ViralLoad AS BIGINT) AS VLValue,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted      = 0
                  AND fu.VisitDate    BETWEEN @PeriodStart AND @PeriodEnd
                  AND fu.ViralLoad    IS NOT NULL
                  AND fu.ViralLoad    != ''
                  AND TRY_CAST(fu.ViralLoad AS BIGINT) IS NOT NULL
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COUNT(*)                                                                     AS Samples,
                SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                                  AS SamplesPreg,
                SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                                  AS SamplesBF,
                SUM(CASE WHEN lv.VLValue < 1000 THEN 1 ELSE 0 END)                          AS Suppressed,
                SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                              AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)           AS SuppressedPreg,
                SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                              AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                  AS SuppressedBF,
                SUM(CASE WHEN lv.VLValue >= 1000 THEN 1 ELSE 0 END)                         AS Unsuppressed,
                SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                              AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)           AS UnsuppressedPreg,
                SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                              AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                  AS UnsuppressedBF
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf  ON hf.HealthFacilityID = p.NearestHFID
            JOIN   LatestVLInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        var vlTracedSql = $"""
            WITH HighVLInPeriod AS (
                SELECT
                    fu.PtDetailsTID,
                    fu.VisitDate AS HighVLDate,
                    ROW_NUMBER() OVER (
                        PARTITION BY fu.PtDetailsTID
                        ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC
                    ) AS rn
                FROM PtFollowUpARTT fu
                WHERE fu.Deleted   = 0
                  AND fu.VisitDate BETWEEN @PeriodStart AND @PeriodEnd
                  AND TRY_CAST(fu.ViralLoad AS BIGINT) >= 1000
            )
            SELECT
                p.SexID,
                {AgeGroupCase} AS AgeGrp,
                COUNT(*)                                                              AS Traced,
                SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL
                         THEN 1 ELSE 0 END)                                          AS Pregnant,
                SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2
                         THEN 1 ELSE 0 END)                                          AS Breastfeeding
            FROM   PtDetailsARTT      p
            JOIN   HealthFacilityT hf  ON hf.HealthFacilityID = p.NearestHFID
            JOIN   HighVLInPeriod  hv  ON hv.PtDetailsTID = p.PtDetailsTID AND hv.rn = 1
            LEFT JOIN (
                SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT
            ) preg ON preg.PtDetailsTID = p.PtDetailsTID
            WHERE  p.Deleted      = 0
              AND  p.IsTransferIn = 0
              AND  EXISTS (
                       SELECT 1 FROM PtFollowUpARTT fu2
                       WHERE  fu2.PtDetailsTID = p.PtDetailsTID
                         AND  fu2.Deleted      = 0
                         AND  fu2.VisitDate    > hv.HighVLDate
                   )
              {geoAnd}
            GROUP  BY p.SexID,
                      {AgeGroupCase}
            ORDER  BY AgeGrp, p.SexID
            """;

        string? baselineSql = null;
        if (cleanFacIds.Length > 0)
        {
            var baseFacParams = cleanFacIds.Select((_, i) => $"@BaseFacId{i}");
            baselineSql = $"""
                SELECT
                    SUM(AgeGrp0_M)  AS AG0M,  SUM(AgeGrp0_F)  AS AG0F,
                    SUM(AgeGrp1_M)  AS AG1M,  SUM(AgeGrp1_F)  AS AG1F,
                    SUM(AgeGrp2_M)  AS AG2M,  SUM(AgeGrp2_F)  AS AG2F,
                    SUM(AgeGrp3_M)  AS AG3M,  SUM(AgeGrp3_F)  AS AG3F,
                    SUM(AgeGrp4_M)  AS AG4M,  SUM(AgeGrp4_F)  AS AG4F,
                    SUM(AgeGrp5_M)  AS AG5M,  SUM(AgeGrp5_F)  AS AG5F,
                    SUM(AgeGrp6_M)  AS AG6M,  SUM(AgeGrp6_F)  AS AG6F,
                    SUM(AgeGrp7_M)  AS AG7M,  SUM(AgeGrp7_F)  AS AG7F,
                    SUM(AgeGrp8_M)  AS AG8M,  SUM(AgeGrp8_F)  AS AG8F,
                    SUM(AgeGrp9_M)  AS AG9M,  SUM(AgeGrp9_F)  AS AG9F,
                    SUM(AgeGrp10_M) AS AG10M, SUM(AgeGrp10_F) AS AG10F,
                    SUM(AgeGrp11_M) AS AG11M, SUM(AgeGrp11_F) AS AG11F,
                    SUM(CTXTotal_M)     AS CTXTotalM,
                    SUM(CTXTotal_F)     AS CTXTotalF,
                    SUM(DapsoneTotal_M) AS DapsoneTotalM,
                    SUM(DapsoneTotal_F) AS DapsoneTotalF
                FROM FacilityBaselineT
                WHERE HealthFacilityID IN ({string.Join(", ", baseFacParams)})
                  AND BaselineDate < @PeriodStart
                """;
        }

        // ── Data accumulators (identical to ArtMonthly) ──────────────────
        int[,] prevCumul      = new int[12, 2];
        int[,] newInPeriod    = new int[12, 2];
        int[,] newPregnant    = new int[12, 2];
        int[,] newBreastfeed  = new int[12, 2];
        int ctxMale = 0, ctxFemale = 0, dapsoneMale = 0, dapsoneFemale = 0;
        int ctxNewMale = 0, ctxNewFemale = 0, ctxNewPregnant = 0, ctxNewBreastfeed = 0;
        int dapsoneNewMale = 0, dapsoneNewFemale = 0, dapsoneNewPregnant = 0, dapsoneNewBreastfeed = 0;
        int[,] art1stCount = new int[12, 2];
        int[,] art2ndCount = new int[12, 2];
        int[]  art1stPreg  = new int[12];
        int[]  art1stBF    = new int[12];
        int[]  art2ndPreg  = new int[12];
        int[]  art2ndBF    = new int[12];
        int[,] tbStatusCount = new int[6, 4];
        int tbRxM = 0, tbRxF = 0, tbRxPreg = 0, tbRxBF = 0;
        int[,] ctxPage2  = new int[4, 2];
        int[,] dapsPage2 = new int[4, 2];
        int[,] ltfuPage2 = new int[4, 2];
        int[,] deathsPage2 = new int[4, 2];
        int ctxBF = 0, ctxPreg = 0, dapsBF = 0, dapsPreg = 0;
        int ltfuBF = 0, ltfuPreg = 0, deathsBF = 0, deathsPreg = 0;
        var regimenAgeCounts  = new Dictionary<string, int[,]>(StringComparer.OrdinalIgnoreCase);
        var regimenPregTotals = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var regimenBFTotals   = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        int[,] vlSamples     = new int[12, 2];
        int[]  vlSamplesPreg = new int[12];
        int[]  vlSamplesBF   = new int[12];
        int[,] vlSupp        = new int[12, 2];
        int[]  vlSuppPreg    = new int[12];
        int[]  vlSuppBF      = new int[12];
        int[,] vlUnsupp      = new int[12, 2];
        int[]  vlUnsuppPreg  = new int[12];
        int[]  vlUnsuppBF    = new int[12];
        int[,] vlTraced      = new int[12, 2];
        int[]  vlTracedPreg  = new int[12];
        int[]  vlTracedBF    = new int[12];
        string facilityLabel = "All Facilities";
        string geoFilePrefix = "National";

        // ── SSE response setup ────────────────────────────────────────────
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.Append("Cache-Control", "no-cache, no-store");
        Response.Headers.Append("X-Accel-Buffering", "no");
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        // totalSteps: 12 queries + optional baseline + Excel building
        int totalSteps = (cleanFacIds.Length > 0 ? 14 : 13);
        int step = 0;

        async Task Emit(object payload)
        {
            var json = JsonSerializer.Serialize(payload, SseJsonOptions);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        async Task Progress(string label)
        {
            step++;
            await Emit(new { step, total = totalSteps, label });
        }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync(ct);

            // Step 1
            await Progress("Resolving facility information…");
            (facilityLabel, geoFilePrefix) = await ResolveFacilityLabel(conn, cleanFacIds, isNgo, userSubRecId);

            // Step 2 — Page 1: patient enrollment by age / sex
            await Progress("Loading patient enrollment data (Page 1)…");
            await using (var cmd = new SqlCommand(mainSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int prev   = rdr.GetInt32(rdr.GetOrdinal("PrevCumul"));
                    int newPt  = rdr.GetInt32(rdr.GetOrdinal("NewInPeriod"));
                    int bf     = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int preg   = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;
                    prevCumul[ageGrp, si]     += prev;
                    newInPeriod[ageGrp, si]   += newPt;
                    newPregnant[ageGrp, si]   += preg;
                    newBreastfeed[ageGrp, si] += bf;
                }
            }

            // Step 3 — CTX / Dapsone cumulative
            await Progress("Loading CPT/Dapsone cumulative (Page 1)…");
            await using (var cmd = new SqlCommand(ctxSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int drugId = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total  = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    bool isMale = sexId != 2;
                    if      (drugId == 1 && isMale)  ctxMale      += total;
                    else if (drugId == 1 && !isMale) ctxFemale    += total;
                    else if (drugId == 2 && isMale)  dapsoneMale  += total;
                    else if (drugId == 2 && !isMale) dapsoneFemale+= total;
                }
            }

            // Step 4 — CTX / Dapsone new in period
            await Progress("Loading CPT/Dapsone new in period (Page 1)…");
            await using (var cmd = new SqlCommand(ctxNewSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int drugId  = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    bool isMale = sexId != 2;
                    if (drugId == 1)
                    {
                        if (isMale) ctxNewMale += total;
                        else { ctxNewFemale += total; ctxNewPregnant += preg; ctxNewBreastfeed += bf; }
                    }
                    else if (drugId == 2)
                    {
                        if (isMale) dapsoneNewMale += total;
                        else { dapsoneNewFemale += total; dapsoneNewPregnant += preg; dapsoneNewBreastfeed += bf; }
                    }
                }
            }

            // Step 5 — Current on ART
            await Progress("Loading current patients on ART (Page 2)…");
            await using (var cmd = new SqlCommand(currentOnArtSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int catId  = rdr.GetInt32(rdr.GetOrdinal("RegimenCatID"));
                    int total  = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg   = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf     = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;
                    bool is1st = catId != 2 && catId != 4;
                    if (is1st)
                    {
                        art1stCount[ageGrp, si] += total;
                        if (si == 1) { art1stPreg[ageGrp] += preg; art1stBF[ageGrp] += bf; }
                    }
                    else
                    {
                        art2ndCount[ageGrp, si] += total;
                        if (si == 1) { art2ndPreg[ageGrp] += preg; art2ndBF[ageGrp] += bf; }
                    }
                }
            }

            // Step 6 — TB status
            await Progress("Loading TB status data (Page 2)…");
            await using (var cmd = new SqlCommand(tbStatusSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int tbId  = rdr.GetInt32(rdr.GetOrdinal("TBStatusID"));
                    int total = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg  = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf    = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (tbId < 1 || tbId > 5) continue;
                    tbStatusCount[tbId, si] += total;
                    if (si == 1) { tbStatusCount[tbId, 2] += preg; tbStatusCount[tbId, 3] += bf; }
                }
            }

            // Step 7 — TB Rx started
            await Progress("Loading TB treatment data (Page 2)…");
            await using (var cmd = new SqlCommand(tbRxStartedSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int total = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg  = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf    = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    if (sexId != 2) tbRxM += total;
                    else { tbRxF += total; tbRxPreg += preg; tbRxBF += bf; }
                }
            }

            // Step 8 — CTX / Dapsone for current patients (Page 2)
            await Progress("Loading CPT/Dapsone for current patients (Page 2)…");
            await using (var cmd = new SqlCommand(ctxDapsonePage2Sql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int bracket = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int drugId  = rdr.GetInt32(rdr.GetOrdinal("CPTDrugID"));
                    int total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;
                    if (drugId == 1) { ctxPage2[bracket, si] += total; ctxPreg += preg; ctxBF += bf; }
                    else if (drugId == 2) { dapsPage2[bracket, si] += total; dapsPreg += preg; dapsBF += bf; }
                }
            }

            // Step 9 — LTFU and Deaths
            await Progress("Loading LTFU and death records (Page 2)…");
            await using (var cmd = new SqlCommand(ltfuDeathsSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId    = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int bracket  = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int statusId = rdr.GetInt32(rdr.GetOrdinal("FollowUpStatusID"));
                    int total    = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int preg     = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf       = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;
                    if (statusId == 5) { ltfuPage2[bracket, si] += total; ltfuPreg += preg; ltfuBF += bf; }
                    else if (statusId == 2) { deathsPage2[bracket, si] += total; deathsPreg += preg; deathsBF += bf; }
                }
            }

            // Step 10 — Per-regimen breakdown
            await Progress("Loading regimen breakdown (Page 2)…");
            await using (var cmd = new SqlCommand(perRegimenSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    string code    = rdr.GetString(rdr.GetOrdinal("RegimenCode"));
                    int    sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int    bracket = rdr.GetInt32(rdr.GetOrdinal("AgeBracket"));
                    int    total   = rdr.GetInt32(rdr.GetOrdinal("Total"));
                    int    preg    = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int    bf      = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (bracket < 0 || bracket > 3) continue;
                    if (!regimenAgeCounts.TryGetValue(code, out var counts))
                    { counts = new int[4, 2]; regimenAgeCounts[code] = counts; }
                    counts[bracket, si] += total;
                    regimenPregTotals[code] = (regimenPregTotals.TryGetValue(code, out var ep) ? ep : 0) + preg;
                    regimenBFTotals[code]   = (regimenBFTotals.TryGetValue(code, out var eb)   ? eb : 0) + bf;
                }
            }

            // Step 11 — Viral load samples
            await Progress("Loading viral load data (Page 3)…");
            await using (var cmd = new SqlCommand(vlSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId      = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp     = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int samples    = rdr.GetInt32(rdr.GetOrdinal("Samples"));
                    int sampPreg   = rdr.GetInt32(rdr.GetOrdinal("SamplesPreg"));
                    int sampBF     = rdr.GetInt32(rdr.GetOrdinal("SamplesBF"));
                    int supp       = rdr.GetInt32(rdr.GetOrdinal("Suppressed"));
                    int suppPreg   = rdr.GetInt32(rdr.GetOrdinal("SuppressedPreg"));
                    int suppBF     = rdr.GetInt32(rdr.GetOrdinal("SuppressedBF"));
                    int unsupp     = rdr.GetInt32(rdr.GetOrdinal("Unsuppressed"));
                    int unsuppPreg = rdr.GetInt32(rdr.GetOrdinal("UnsuppressedPreg"));
                    int unsuppBF   = rdr.GetInt32(rdr.GetOrdinal("UnsuppressedBF"));
                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;
                    vlSamples[ageGrp, si] += samples;
                    vlSupp[ageGrp, si]    += supp;
                    vlUnsupp[ageGrp, si]  += unsupp;
                    if (si == 1)
                    {
                        vlSamplesPreg[ageGrp] += sampPreg; vlSamplesBF[ageGrp] += sampBF;
                        vlSuppPreg[ageGrp]    += suppPreg; vlSuppBF[ageGrp]    += suppBF;
                        vlUnsuppPreg[ageGrp]  += unsuppPreg; vlUnsuppBF[ageGrp] += unsuppBF;
                    }
                }
            }

            // Step 12 — High VL traced
            await Progress("Loading high VL tracing data (Page 3)…");
            await using (var cmd = new SqlCommand(vlTracedSql, conn))
            {
                foreach (var (k, v) in sqlParams) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int sexId  = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int ageGrp = rdr.GetInt32(rdr.GetOrdinal("AgeGrp"));
                    int traced = rdr.GetInt32(rdr.GetOrdinal("Traced"));
                    int preg   = rdr.GetInt32(rdr.GetOrdinal("Pregnant"));
                    int bf     = rdr.GetInt32(rdr.GetOrdinal("Breastfeeding"));
                    int si = sexId == 2 ? 1 : 0;
                    if (ageGrp < 0 || ageGrp > 11) continue;
                    vlTraced[ageGrp, si] += traced;
                    if (si == 1) { vlTracedPreg[ageGrp] += preg; vlTracedBF[ageGrp] += bf; }
                }
            }

            // Step 13 (conditional) — Baseline period validation + aggregate
            if (cleanFacIds.Length > 0)
            {
                await Progress("Loading facility baseline data…");

                // Baseline period validation (single-facility only)
                if (cleanFacIds.Length == 1)
                {
                    const string checkSql = """
                        SELECT b.BaselineDate
                        FROM   FacilityBaselineT b
                        WHERE  b.HealthFacilityID = @CheckFacId
                          AND  b.BaselineDate >= @PeriodStart
                        """;
                    await using var chkCmd = new SqlCommand(checkSql, conn);
                    chkCmd.Parameters.AddWithValue("@CheckFacId", cleanFacIds[0]);
                    chkCmd.Parameters.AddWithValue("@PeriodStart", periodStart);
                    var dbDate = await chkCmd.ExecuteScalarAsync(ct);
                    if (dbDate is not null and not DBNull)
                    {
                        var blDate = DateOnly.FromDateTime((DateTime)dbDate);
                        await Emit(new
                        {
                            error = $"The report period ({periodStart:MMMM yyyy}) starts on or before the " +
                                    $"configured baseline date ({blDate:MMMM yyyy}). " +
                                    "Please configure an earlier baseline date or choose a later reporting period.",
                            errorCode = "PERIOD_BEFORE_BASELINE"
                        });
                        return;
                    }
                }

                // Baseline aggregate
                await using var blCmd = new SqlCommand(baselineSql!, conn);
                blCmd.Parameters.AddWithValue("@PeriodStart", periodStart);
                for (int i = 0; i < cleanFacIds.Length; i++)
                    blCmd.Parameters.AddWithValue($"@BaseFacId{i}", cleanFacIds[i]);

                await using var blRdr = await blCmd.ExecuteReaderAsync(ct);
                if (await blRdr.ReadAsync(ct) && !blRdr.IsDBNull(0))
                {
                    string[] aliases =
                    [
                        "AG0M","AG0F","AG1M","AG1F","AG2M","AG2F","AG3M","AG3F",
                        "AG4M","AG4F","AG5M","AG5F","AG6M","AG6F","AG7M","AG7F",
                        "AG8M","AG8F","AG9M","AG9F","AG10M","AG10F","AG11M","AG11F",
                        "CTXTotalM","CTXTotalF","DapsoneTotalM","DapsoneTotalF"
                    ];
                    for (int ag = 0; ag <= 11; ag++)
                    {
                        int blMale   = blRdr.IsDBNull(blRdr.GetOrdinal(aliases[ag * 2]))
                                       ? 0 : blRdr.GetInt32(blRdr.GetOrdinal(aliases[ag * 2]));
                        int blFemale = blRdr.IsDBNull(blRdr.GetOrdinal(aliases[ag * 2 + 1]))
                                       ? 0 : blRdr.GetInt32(blRdr.GetOrdinal(aliases[ag * 2 + 1]));
                        prevCumul[ag, 0] += blMale;
                        prevCumul[ag, 1] += blFemale;
                    }
                    if (!blRdr.IsDBNull(blRdr.GetOrdinal("CTXTotalM")))  ctxMale       += blRdr.GetInt32(blRdr.GetOrdinal("CTXTotalM"));
                    if (!blRdr.IsDBNull(blRdr.GetOrdinal("CTXTotalF")))  ctxFemale     += blRdr.GetInt32(blRdr.GetOrdinal("CTXTotalF"));
                    if (!blRdr.IsDBNull(blRdr.GetOrdinal("DapsoneTotalM"))) dapsoneMale  += blRdr.GetInt32(blRdr.GetOrdinal("DapsoneTotalM"));
                    if (!blRdr.IsDBNull(blRdr.GetOrdinal("DapsoneTotalF"))) dapsoneFemale+= blRdr.GetInt32(blRdr.GetOrdinal("DapsoneTotalF"));
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected — stop silently.
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ART Report SSE stream for {Start}-{End}.", startDate, endDate);
            try { await Emit(new { error = "Report generation failed. Please try again.", detail = ex.Message }); } catch { }
            return;
        }

        // ── Build Excel workbook ──────────────────────────────────────────
        step++; // this is the final Excel-building step
        await Emit(new { step, total = totalSteps, label = "Building Excel workbook…" });

        var templatePath = Path.Combine(_env.ContentRootPath, "Templates", "ART_Monthly_Report_Form_Rev.xlsx");
        if (!System.IO.File.Exists(templatePath))
        {
            await Emit(new { error = "Report template file is missing on the server." });
            return;
        }

        byte[] excelBytes;
        string fileName;
        try
        {
            await using var templateStream = new FileStream(templatePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var workbook = new XLWorkbook(templateStream);
            var ws = workbook.Worksheet("Page 1");

            ws.Cell("B7").Value = facilityLabel;
            ws.Cell("I7").Value = periodLabel;

            for (int ag = 0; ag <= 11; ag++)
            {
                int row = 13 + ag;
                ws.Cell(row, 2).Value = prevCumul[ag, 0];
                ws.Cell(row, 3).Value = prevCumul[ag, 1];
                ws.Cell(row, 5).Value = newInPeriod[ag, 0];
                ws.Cell(row, 6).Value = newInPeriod[ag, 1];
                ws.Cell(row, 7).Value = newPregnant[ag, 1];
                ws.Cell(row, 8).Value = newBreastfeed[ag, 1];
            }

            ws.Cell("B26").Value = ctxMale;     ws.Cell("C26").Value = ctxFemale;
            ws.Cell("B27").Value = dapsoneMale; ws.Cell("C27").Value = dapsoneFemale;
            ws.Cell("E26").Value = ctxNewMale;      ws.Cell("F26").Value = ctxNewFemale;
            ws.Cell("G26").Value = ctxNewPregnant;  ws.Cell("H26").Value = ctxNewBreastfeed;
            ws.Cell("E27").Value = dapsoneNewMale;  ws.Cell("F27").Value = dapsoneNewFemale;
            ws.Cell("G27").Value = dapsoneNewPregnant; ws.Cell("H27").Value = dapsoneNewBreastfeed;

            var ws2 = workbook.Worksheet("Page 2");
            ws2.Cell("B5").Value = facilityLabel;
            ws2.Cell("J5").Value = periodLabel;

            for (int ag = 0; ag <= 11; ag++)
            {
                int r1 = 10 + ag;
                ws2.Cell(r1, 4).Value  = art1stCount[ag, 0];
                ws2.Cell(r1, 6).Value  = art1stCount[ag, 1];
                ws2.Cell(r1, 8).Value  = art1stPreg[ag];
                ws2.Cell(r1, 10).Value = art1stBF[ag];
            }
            for (int ag = 0; ag <= 11; ag++)
            {
                int r2 = 25 + ag;
                ws2.Cell(r2, 4).Value  = art2ndCount[ag, 0];
                ws2.Cell(r2, 6).Value  = art2ndCount[ag, 1];
                ws2.Cell(r2, 8).Value  = art2ndPreg[ag];
                ws2.Cell(r2, 10).Value = art2ndBF[ag];
            }

            int[] tbStatusRows = { 41, 42, 43, 44, 45 };
            for (int i = 0; i < tbStatusRows.Length; i++)
            {
                int tbId = i + 1; int rowTb = tbStatusRows[i];
                ws2.Cell(rowTb, 4).Value  = tbStatusCount[tbId, 0];
                ws2.Cell(rowTb, 6).Value  = tbStatusCount[tbId, 1];
                ws2.Cell(rowTb, 8).Value  = tbStatusCount[tbId, 2];
                ws2.Cell(rowTb, 10).Value = tbStatusCount[tbId, 3];
            }
            ws2.Cell(46, 4).Value = tbRxM; ws2.Cell(46, 6).Value = tbRxF;
            ws2.Cell(46, 8).Value = tbRxPreg; ws2.Cell(46, 10).Value = tbRxBF;

            for (int b = 0; b < 4; b++)
            {
                int colM = 2 + b * 2; int colF = 3 + b * 2;
                ws2.Cell(95, colM).Value = ctxPage2[b, 0];    ws2.Cell(95, colF).Value = ctxPage2[b, 1];
                ws2.Cell(96, colM).Value = dapsPage2[b, 0];   ws2.Cell(96, colF).Value = dapsPage2[b, 1];
                ws2.Cell(97, colM).Value = ltfuPage2[b, 0];   ws2.Cell(97, colF).Value = ltfuPage2[b, 1];
                ws2.Cell(98, colM).Value = deathsPage2[b, 0]; ws2.Cell(98, colF).Value = deathsPage2[b, 1];
            }
            ws2.Cell(95, 11).Value = ctxBF;    ws2.Cell(95, 12).Value = ctxPreg;
            ws2.Cell(96, 11).Value = dapsBF;   ws2.Cell(96, 12).Value = dapsPreg;
            ws2.Cell(97, 11).Value = ltfuBF;   ws2.Cell(97, 12).Value = ltfuPreg;
            ws2.Cell(98, 11).Value = deathsBF; ws2.Cell(98, 12).Value = deathsPreg;

            foreach (var (code, row) in RegimenCodeToRow)
            {
                regimenAgeCounts.TryGetValue(code, out var counts);
                regimenPregTotals.TryGetValue(code, out var pregTotal);
                regimenBFTotals.TryGetValue(code, out var bfTotal);
                SW(ws2.Cell(row, 2),  counts?[0, 0] ?? 0);
                SW(ws2.Cell(row, 3),  counts?[0, 1] ?? 0);
                SW(ws2.Cell(row, 4),  counts?[1, 0] ?? 0);
                SW(ws2.Cell(row, 5),  counts?[1, 1] ?? 0);
                SW(ws2.Cell(row, 6),  counts?[2, 0] ?? 0);
                SW(ws2.Cell(row, 7),  counts?[2, 1] ?? 0);
                SW(ws2.Cell(row, 8),  counts?[3, 0] ?? 0);
                SW(ws2.Cell(row, 9),  counts?[3, 1] ?? 0);
                SW(ws2.Cell(row, 11), bfTotal);
                SW(ws2.Cell(row, 12), pregTotal);
            }

            var ws3 = workbook.Worksheet("Page 3");
            ws3.Cell("B5").Value = facilityLabel;
            ws3.Cell("T5").Value = periodLabel;
            for (int ag = 0; ag <= 11; ag++)
            {
                int r = 11 + ag;
                ws3.Cell(r,  2).Value = vlSamples[ag, 0];  ws3.Cell(r,  3).Value = vlSamples[ag, 1];
                ws3.Cell(r,  4).Value = vlSamplesPreg[ag]; ws3.Cell(r,  5).Value = vlSamplesBF[ag];
                ws3.Cell(r,  7).Value = vlSupp[ag, 0];     ws3.Cell(r,  8).Value = vlSupp[ag, 1];
                ws3.Cell(r,  9).Value = vlSuppPreg[ag];    ws3.Cell(r, 10).Value = vlSuppBF[ag];
                ws3.Cell(r, 12).Value = vlUnsupp[ag, 0];   ws3.Cell(r, 13).Value = vlUnsupp[ag, 1];
                ws3.Cell(r, 14).Value = vlUnsuppPreg[ag];  ws3.Cell(r, 15).Value = vlUnsuppBF[ag];
                ws3.Cell(r, 17).Value = vlTraced[ag, 0];   ws3.Cell(r, 18).Value = vlTraced[ag, 1];
                ws3.Cell(r, 19).Value = vlTracedPreg[ag];  ws3.Cell(r, 20).Value = vlTracedBF[ag];
            }

            using var ms = new MemoryStream();
            workbook.SaveAs(ms);
            excelBytes = ms.ToArray();
            fileName = $"{geoFilePrefix}_ART_Report_{filePeriod}_SV.xlsx";
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error building Excel workbook in SSE report.");
            try { await Emit(new { error = "Failed to produce the report file.", detail = ex.Message }); } catch { }
            return;
        }

        // ── Cache the result and emit the done event ──────────────────────
        var token = Guid.NewGuid().ToString("N");
        _cache.Set(token, new ReportCacheEntry(excelBytes, fileName),
            new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });

        await Emit(new { done = true, token, filename = fileName });
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/art-monthly-download?token=<token>
    //
    //  One-time download endpoint: retrieves the Excel file that was
    //  prepared by art-monthly-progress and cached in IMemoryCache.
    //  The token is consumed (removed) on first use.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("art-monthly-download")]
    public IActionResult ArtMonthlyDownload([FromQuery] string token)
    {
        // Validate token is a 32-hex-char GUID (format "N") to prevent
        // arbitrary strings being used as cache keys.
        if (string.IsNullOrEmpty(token) || !Guid.TryParseExact(token, "N", out _))
            return BadRequest(new { error = "Invalid or missing download token." });

        if (!_cache.TryGetValue(token, out ReportCacheEntry? entry) || entry is null)
            return NotFound(new { error = "Download token has expired or was not found. Please regenerate the report." });

        // One-time use — remove from cache immediately.
        _cache.Remove(token);

        return File(entry.Bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            entry.Filename);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/tb-quarterly-progress
    //
    //  Generates the DSTB NTP Report from the server-side Excel template and
    //  streams SSE progress events to the client.  On completion a download
    //  token is stored in IMemoryCache (5-minute TTL) and emitted in the
    //  final done event.
    //
    //  Parameters:
    //    cfStartDate  — Case Finding start date (yyyy-MM-dd)
    //    cfEndDate    — Case Finding end date   (yyyy-MM-dd)
    //                   Period length is derived from these two dates:
    //                     3 months  → quarterly
    //                     6 months  → semiannual
    //                     12 months → annual
    //                   SC = one period immediately before CF
    //                   TO = same period one year before CF
    //    facilityIds[]— Optional facility ID filter
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("tb-quarterly-progress")]
    public async Task TbQuarterlyProgress(
        [FromQuery] string cfStartDate,
        [FromQuery] string cfEndDate,
        [FromQuery] int[]? facilityIds = null)
    {
        var ct = HttpContext.RequestAborted;

        // ── Input validation ─────────────────────────────────────────────
        if (!DateOnly.TryParse(cfStartDate, out var cfStart))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfStartDate is not a valid date." }); return; }
        if (!DateOnly.TryParse(cfEndDate, out var cfEnd))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfEndDate is not a valid date." }); return; }
        if (cfEnd < cfStart)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfEndDate must be on or after cfStartDate." }); return; }

        // ── Derive period length and all three cohort date ranges ─────────
        // Period in months (3 = quarterly, 6 = semiannual, 12 = annual)
        int periodMonths = (cfEnd.Year - cfStart.Year) * 12 + cfEnd.Month - cfStart.Month + 1;

        // SC = one period immediately before CF
        var scStart = cfStart.AddMonths(-periodMonths);
        var scEnd   = cfEnd.AddMonths(-periodMonths);

        // TO = same period one year before CF
        var toStart = cfStart.AddMonths(-12);
        var toEnd   = cfEnd.AddMonths(-12);

        // Period ordinal for Excel header labels (1-4 quarterly, 1-2 semiannual, 0 = annual)
        int cfOrdinal = periodMonths switch { 3 => (cfStart.Month - 1) / 3 + 1, 6 => cfStart.Month <= 6 ? 1 : 2, _ => 0 };
        int scOrdinal = periodMonths switch { 3 => (scStart.Month - 1) / 3 + 1, 6 => scStart.Month <= 6 ? 1 : 2, _ => 0 };
        int toOrdinal = periodMonths switch { 3 => (toStart.Month - 1) / 3 + 1, 6 => toStart.Month <= 6 ? 1 : 2, _ => 0 };
        var cfYearStr  = cfStart.Year.ToString();
        var scYearStr  = scStart.Year.ToString();
        var toYearStr  = toStart.Year.ToString();
        string periodLabel = periodMonths switch { 3 => $"Q{cfOrdinal}", 6 => $"H{cfOrdinal}", _ => "Annual" };

        var callerName = User.FindFirstValue(ClaimTypes.Name) ?? User.FindFirstValue("sub") ?? "unknown";
        _logger.LogInformation(
            "TB NTP Report (SSE) requested by {User} — CF={CfStart}–{CfEnd} ({PeriodMonths}mo), SC={ScStart}–{ScEnd}, TO={ToStart}–{ToEnd}, facilityIds=[{FacIds}]",
            callerName, cfStart, cfEnd, periodMonths, scStart, scEnd, toStart, toEnd,
            string.Join(",", facilityIds ?? []));

        // ── JWT scope ─────────────────────────────────────────────────────
        bool isNgo   = User.IsInRole("NGO");
        bool isZonal = User.IsInRole("StateCoordinator");
        bool isDtls  = User.IsInRole("CountySupervisor");
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),  out var userSubRecId);
        int.TryParse(User.FindFirstValue("location_id"), out var userLocationId);

        if (userFacilityId > 0)
            facilityIds = [userFacilityId];

        // ── Geo WHERE clause ──────────────────────────────────────────────
        var cleanFacIds   = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var geoConditions = new List<string>();
        var baseParams    = new Dictionary<string, object>();

        if (cleanFacIds.Length > 0)
        {
            var pNames = cleanFacIds.Select((_, i) => $"@FacId{i}");
            geoConditions.Add($"hf.HealthFacilityID IN ({string.Join(", ", pNames)})");
            for (int i = 0; i < cleanFacIds.Length; i++)
                baseParams[$"@FacId{i}"] = cleanFacIds[i];
        }
        if (isNgo && userSubRecId > 0)
        {
            geoConditions.Add("hf.SubRecID = @SubRecId");
            baseParams["@SubRecId"] = userSubRecId;
            if ((isZonal || isDtls) && userLocationId > 0)
            {
                geoConditions.Add("hf.LocationID = @LocationId");
                baseParams["@LocationId"] = userLocationId;
            }
        }
        var geoAnd = geoConditions.Count > 0
            ? "AND " + string.Join(" AND ", geoConditions)
            : string.Empty;

        // ── SQL definitions ───────────────────────────────────────────────
        // Case-finding query: patients registered during the CF period.
        var cfSql = $"""
            SELECT
                pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age, pd.DiagMethodID,
                fu.Mon0LabResultID, fu.Mon0XpertResultID,
                fu.HIVTestResultID, fu.OnART, fu.OnCPT
            FROM PtDetailsT pd
            LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pd.NearestHFID
            WHERE pd.Deleted = 0
              AND pd.PtTypeID IN (1, 2, 3, 4, 6)
              AND pd.RegDate BETWEEN @CfStart AND @CfEnd
              {geoAnd}
            """;

        // Sputum conversion query: patients registered during the SC period.
        var scSql = $"""
            SELECT
                pd.PtTypeID, pd.TbTypeID,
                fu.Mon0LabResultID, fu.Mon0XpertResultID,
                fu.Mon2LabResultID, fu.Mon3LabResultID
            FROM PtDetailsT pd
            LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pd.NearestHFID
            WHERE pd.Deleted = 0
              AND pd.PtTypeID IN (1, 2, 3, 4, 6)
              AND pd.RegDate BETWEEN @ScStart AND @ScEnd
              {geoAnd}
            """;

        // Treatment outcomes query: patients registered during the TO period.
        var toSql = $"""
            SELECT
                pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age,
                fu.Mon0LabResultID, fu.Mon0XpertResultID,
                fu.HIVTestResultID, fu.OnART, fu.OnCPT, fu.OutcomeID
            FROM PtDetailsT pd
            LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pd.NearestHFID
            WHERE pd.Deleted = 0
              AND pd.PtTypeID IN (1, 2, 3, 4, 6)
              AND pd.RegDate BETWEEN @ToStart AND @ToEnd
              {geoAnd}
            """;

        // Presumptive cases: monthly tally entries that fall within the CF period.
        var presumptiveSql = $"""
            SELECT COALESCE(SUM(pc.PresumptiveCase), 0) AS Total
            FROM PresumptiveCaseT pc
            JOIN YearT y  ON y.YearID  = pc.YearID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pc.NearestHFID
            WHERE pc.MonthID IS NOT NULL
              AND pc.YearID  IS NOT NULL
              AND DATEFROMPARTS(y.YearName, pc.MonthID, 15) BETWEEN @CfStart AND @CfEnd
              {geoAnd}
            """;

        // ── SSE setup ─────────────────────────────────────────────────────
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.Append("Cache-Control", "no-cache, no-store");
        Response.Headers.Append("X-Accel-Buffering", "no");
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        const int totalSteps = 7; // resolve, CF, SC, TO, presumptive, build Excel, finalise
        int step = 0;

        async Task Emit(object payload)
        {
            var json = JsonSerializer.Serialize(payload, SseJsonOptions);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        async Task Progress(string label)
        {
            step++;
            await Emit(new { step, total = totalSteps, label });
        }

        // ── Case Finding counters ─────────────────────────────────────────
        int cfPBCNew = 0, cfPBCRelapse = 0, cfPBCPrevTreat = 0, cfPBCOther = 0;
        int cfPCDNew = 0, cfPCDRelapse = 0, cfPCDPrevTreat = 0, cfPCDOther = 0;
        int cfEPNew  = 0, cfEPRelapse  = 0, cfEPPrevTreat  = 0, cfEPOther  = 0;
        int cfSuspectsSeen = 0, cfPBCLab = 0;
        int cfTestedHIV = 0, cfTestedHIVPos = 0, cfTestedHIVART = 0, cfTestedHIVCPT = 0;
        int cfGeneXpert = 0, cfMicroscopy = 0, cfTBLam = 0, cfTrueNat = 0, cfXray = 0;
        int cfGeneXpertPos = 0, cfMicroscopyPos = 0, cfTrueNatPos = 0;
        // NTP age-group (0=<5, 1=5-9, 2=10-14, 3=15-19, 4=20-24, 5=25-34,
        //               6=35-44, 7=45-54, 8=55-64, 9=65+): 10 groups × 2 sexes (0=M,1=F)
        int[,] cfPBCNewRelapse = new int[10, 2];
        int[,] cfHIVPos        = new int[10, 2];
        int[,] cfARTHIVPos     = new int[10, 2];

        // ── Sputum Conversion counters ────────────────────────────────────
        int scNewPBC = 0, scSmearND = 0, sc2Months = 0, sc3Months = 0;

        // ── Treatment Outcome counters ────────────────────────────────────
        int toNewPBCM = 0,     toNewPBCF = 0;
        int toNewPBC_CuredM = 0,      toNewPBC_CuredF = 0;
        int toNewPBC_CompletedM = 0,  toNewPBC_CompletedF = 0;
        int toNewPBC_DiedM = 0,       toNewPBC_DiedF = 0;
        int toNewPBC_FailedM = 0,     toNewPBC_FailedF = 0;
        int toNewPBC_LostToFPM = 0,   toNewPBC_LostToFPF = 0;
        int toNewPBC_NotEvalM = 0,    toNewPBC_NotEvalF = 0;

        int toNewPCDEPM = 0,  toNewPCDEPF = 0;
        int toNewPCDEP_CompletedM = 0, toNewPCDEP_CompletedF = 0;
        int toNewPCDEP_DiedM = 0,      toNewPCDEP_DiedF = 0;
        int toNewPCDEP_FailedM = 0,    toNewPCDEP_FailedF = 0;
        int toNewPCDEP_LostToFPM = 0,  toNewPCDEP_LostToFPF = 0;
        int toNewPCDEP_NotEvalM = 0,   toNewPCDEP_NotEvalF = 0;

        int toRelapseM = 0,   toRelapseF = 0;
        int toRelapse_CuredM = 0,     toRelapse_CuredF = 0;
        int toRelapse_CompletedM = 0, toRelapse_CompletedF = 0;
        int toRelapse_DiedM = 0,      toRelapse_DiedF = 0;
        int toRelapse_FailedM = 0,    toRelapse_FailedF = 0;
        int toRelapse_LostToFPM = 0,  toRelapse_LostToFPF = 0;
        int toRelapse_NotEvalM = 0,   toRelapse_NotEvalF = 0;

        // Failure / Lost To FP / Other — no M/F split in the NTP form
        int toFailure = 0,   toFailure_Cured = 0,   toFailure_Completed = 0,
            toFailure_Died = 0, toFailure_Failed = 0, toFailure_LostToFP = 0, toFailure_NotEval = 0;
        int toLostToFP = 0,  toLostToFP_Cured = 0,  toLostToFP_Completed = 0,
            toLostToFP_Died = 0, toLostToFP_Failed = 0, toLostToFP_LostToFP = 0, toLostToFP_NotEval = 0;
        int toOther = 0,     toOther_Cured = 0,     toOther_Completed = 0,
            toOther_Died = 0, toOther_Failed = 0, toOther_LostToFP = 0, toOther_NotEval = 0;

        int toTestedHIV = 0, toTestedHIVPos = 0, toTestedHIVART = 0, toTestedHIVCPT = 0;
        int toHIVPos_Cured = 0, toHIVPos_Completed = 0, toHIVPos_Died = 0,
            toHIVPos_Failed = 0, toHIVPos_LostToFP = 0, toHIVPos_NotEval = 0;
        int toChn = 0,   toChn_Cured = 0,  toChn_Completed = 0,
            toChn_Died = 0, toChn_Failed = 0, toChn_LostToFP = 0, toChn_NotEval = 0;
        int toAdol = 0,  toAdol_Cured = 0, toAdol_Completed = 0,
            toAdol_Died = 0, toAdol_Failed = 0, toAdol_LostToFP = 0, toAdol_NotEval = 0;

        // ── Local helpers ─────────────────────────────────────────────────
        // PBC = bacteriologically confirmed pulmonary: smear+ or Xpert+
        static bool IsSmearPos(int r) => r is 1 or 4 or 5 or 6;
        static bool IsXpertPos(int r) => r is 3 or 4 or 5;
        static bool IsTbPBC(int tbType, int lab, int xpert) =>
            tbType == 1 && (IsSmearPos(lab) || IsXpertPos(xpert));
        static bool IsTbPCD(int tbType, int lab, int xpert) =>
            tbType == 1 && !IsSmearPos(lab) && !IsXpertPos(xpert);

        // NTP age-group index (0=<5 … 9=65+)
        static int NtpAg(int age) => age switch
        {
            < 5  => 0, < 10 => 1, < 15 => 2, < 20 => 3, < 25 => 4,
            < 35 => 5, < 45 => 6, < 55 => 7, < 65 => 8, _   => 9,
        };

        string facilityLabel = "All Facilities";
        string geoFilePrefix = "National";

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync(ct);

            // Step 1 — Resolve facility label
            await Progress("Resolving facility information…");
            (facilityLabel, geoFilePrefix) = await ResolveFacilityLabel(conn, cleanFacIds, isNgo, userSubRecId);

            // Step 2 — Case Finding
            await Progress("Processing Case Finding data…");
            {
                var p = new Dictionary<string, object>(baseParams)
                {
                    ["@CfStart"] = cfStart.ToDateTime(TimeOnly.MinValue),
                    ["@CfEnd"]   = cfEnd.ToDateTime(TimeOnly.MinValue),
                };
                await using var cmd = new SqlCommand(cfSql, conn);
                foreach (var (k, v) in p) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int ptType    = rdr.IsDBNull(rdr.GetOrdinal("PtTypeID"))  ? 0 : rdr.GetInt32(rdr.GetOrdinal("PtTypeID"));
                    int tbType    = rdr.IsDBNull(rdr.GetOrdinal("TbTypeID"))  ? 0 : rdr.GetInt32(rdr.GetOrdinal("TbTypeID"));
                    int sexId     = rdr.IsDBNull(rdr.GetOrdinal("SexID"))     ? 0 : rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int age       = rdr.IsDBNull(rdr.GetOrdinal("Age"))       ? 0 : rdr.GetInt32(rdr.GetOrdinal("Age"));
                    int diagMeth  = rdr.IsDBNull(rdr.GetOrdinal("DiagMethodID"))      ? 0 : rdr.GetInt32(rdr.GetOrdinal("DiagMethodID"));
                    int lab       = rdr.IsDBNull(rdr.GetOrdinal("Mon0LabResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0LabResultID"));
                    int xpert     = rdr.IsDBNull(rdr.GetOrdinal("Mon0XpertResultID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0XpertResultID"));
                    int hivRes    = rdr.IsDBNull(rdr.GetOrdinal("HIVTestResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("HIVTestResultID"));
                    int onART     = rdr.IsDBNull(rdr.GetOrdinal("OnART"))             ? 0 : rdr.GetInt32(rdr.GetOrdinal("OnART"));
                    int onCPT     = rdr.IsDBNull(rdr.GetOrdinal("OnCPT"))             ? 0 : rdr.GetInt32(rdr.GetOrdinal("OnCPT"));

                    bool pbc = IsTbPBC(tbType, lab, xpert);
                    bool pcd = IsTbPCD(tbType, lab, xpert);
                    bool ep  = tbType == 3;
                    int  si  = sexId == 2 ? 1 : 0; // 0=Male, 1=Female
                    int  ag  = NtpAg(age);

                    // Case type × patient type
                    if (pbc)
                    {
                        if      (ptType == 1)         cfPBCNew++;
                        else if (ptType == 2)         cfPBCRelapse++;
                        else if (ptType is 3 or 4)    cfPBCPrevTreat++;
                        else if (ptType == 6)         cfPBCOther++;
                    }
                    else if (pcd)
                    {
                        if      (ptType == 1)         cfPCDNew++;
                        else if (ptType == 2)         cfPCDRelapse++;
                        else if (ptType is 3 or 4)    cfPCDPrevTreat++;
                        else if (ptType == 6)         cfPCDOther++;
                    }
                    else if (ep)
                    {
                        if      (ptType == 1)         cfEPNew++;
                        else if (ptType == 2)         cfEPRelapse++;
                        else if (ptType is 3 or 4)    cfEPPrevTreat++;
                        else if (ptType == 6)         cfEPOther++;
                    }

                    // Age-sex for new + relapse PBC
                    if (pbc && ptType is 1 or 2)
                        cfPBCNewRelapse[ag, si]++;

                    // All PBC (total bacteriologically confirmed)
                    if (pbc) cfPBCLab++;

                    // Diagnostic method counts — new and relapse cases only (PtTypeID 1 or 2)
                    if (ptType is 1 or 2)
                    {
                        switch (diagMeth)
                        {
                            case 1: cfGeneXpert++;  if (IsXpertPos(xpert)) cfGeneXpertPos++; break;
                            case 2: cfMicroscopy++; if (IsSmearPos(lab))   cfMicroscopyPos++; break;
                            case 3: cfTBLam++;      break;  // TB-LAM positive = same as tested (row 28 = row 27)
                            case 4: cfTrueNat++;    if (IsXpertPos(xpert)) cfTrueNatPos++; break;
                            case 5: cfXray++;       break;
                        }
                    }

                    // TB/HIV activities
                    if (hivRes > 0) cfTestedHIV++;
                    if (hivRes == 2)
                    {
                        cfTestedHIVPos++;
                        cfHIVPos[ag, si]++;
                        if (onART == 1) { cfTestedHIVART++; cfARTHIVPos[ag, si]++; }
                        if (onCPT == 1) cfTestedHIVCPT++;
                    }
                }
            }

            // Step 3 — Sputum Conversion
            await Progress("Processing Sputum Conversion data…");
            {
                var p = new Dictionary<string, object>(baseParams)
                {
                    ["@ScStart"] = scStart.ToDateTime(TimeOnly.MinValue),
                    ["@ScEnd"]   = scEnd.ToDateTime(TimeOnly.MinValue),
                };
                await using var cmd = new SqlCommand(scSql, conn);
                foreach (var (k, v) in p) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int ptType = rdr.IsDBNull(rdr.GetOrdinal("PtTypeID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("PtTypeID"));
                    int tbType = rdr.IsDBNull(rdr.GetOrdinal("TbTypeID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("TbTypeID"));
                    int lab    = rdr.IsDBNull(rdr.GetOrdinal("Mon0LabResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0LabResultID"));
                    int xpert  = rdr.IsDBNull(rdr.GetOrdinal("Mon0XpertResultID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0XpertResultID"));
                    int mon2   = rdr.IsDBNull(rdr.GetOrdinal("Mon2LabResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon2LabResultID"));
                    int mon3   = rdr.IsDBNull(rdr.GetOrdinal("Mon3LabResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon3LabResultID"));

                    // Only New PBC patients contribute to sputum conversion
                    if (!IsTbPBC(tbType, lab, xpert) || ptType != 1) continue;

                    scNewPBC++;
                    if      (mon2 == 2)                      sc2Months++;  // converted at 2 months
                    else if (mon3 == 2)                      sc3Months++;  // converted at 3 months
                    else if (mon2 is 0 or 3 or 7
                          && mon3 is 0 or 3 or 7)            scSmearND++;  // smear not done at either visit
                }
            }

            // Step 4 — Treatment Outcomes
            await Progress("Processing Treatment Outcomes data…");
            {
                var p = new Dictionary<string, object>(baseParams)
                {
                    ["@ToStart"] = toStart.ToDateTime(TimeOnly.MinValue),
                    ["@ToEnd"]   = toEnd.ToDateTime(TimeOnly.MinValue),
                };
                await using var cmd = new SqlCommand(toSql, conn);
                foreach (var (k, v) in p) cmd.Parameters.AddWithValue(k, v);
                await using var rdr = await cmd.ExecuteReaderAsync(ct);
                while (await rdr.ReadAsync(ct))
                {
                    int ptType  = rdr.IsDBNull(rdr.GetOrdinal("PtTypeID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("PtTypeID"));
                    int tbType  = rdr.IsDBNull(rdr.GetOrdinal("TbTypeID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("TbTypeID"));
                    int sexId   = rdr.IsDBNull(rdr.GetOrdinal("SexID"))    ? 0 : rdr.GetInt32(rdr.GetOrdinal("SexID"));
                    int age     = rdr.IsDBNull(rdr.GetOrdinal("Age"))      ? 0 : rdr.GetInt32(rdr.GetOrdinal("Age"));
                    int lab     = rdr.IsDBNull(rdr.GetOrdinal("Mon0LabResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0LabResultID"));
                    int xpert   = rdr.IsDBNull(rdr.GetOrdinal("Mon0XpertResultID")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("Mon0XpertResultID"));
                    int hivRes  = rdr.IsDBNull(rdr.GetOrdinal("HIVTestResultID"))   ? 0 : rdr.GetInt32(rdr.GetOrdinal("HIVTestResultID"));
                    int onART   = rdr.IsDBNull(rdr.GetOrdinal("OnART"))             ? 0 : rdr.GetInt32(rdr.GetOrdinal("OnART"));
                    int onCPT   = rdr.IsDBNull(rdr.GetOrdinal("OnCPT"))             ? 0 : rdr.GetInt32(rdr.GetOrdinal("OnCPT"));
                    int outcome = rdr.IsDBNull(rdr.GetOrdinal("OutcomeID"))         ? 0 : rdr.GetInt32(rdr.GetOrdinal("OutcomeID"));

                    bool pbc     = IsTbPBC(tbType, lab, xpert);
                    bool pcdOrEP = IsTbPCD(tbType, lab, xpert) || tbType == 3;
                    int  si      = sexId == 2 ? 1 : 0;

                    // Outcome flags  (0 = not yet assigned → treated as Not Evaluated)
                    bool isCured     = outcome == 1;
                    bool isCompleted = outcome == 2;
                    bool isDied      = outcome == 3;
                    bool isFailed    = outcome == 4;
                    bool isLostToFP  = outcome == 5;
                    bool isNotEval   = outcome is 6 or 0;

                    // Inline helper for the sex-split rows
                    void AddOutcome(ref int totM, ref int totF,
                                    ref int curM, ref int curF,
                                    ref int comM, ref int comF,
                                    ref int dieM, ref int dieF,
                                    ref int filM, ref int filF,
                                    ref int lsM,  ref int lsF,
                                    ref int neM,  ref int neF,
                                    bool includeCured)
                    {
                        if (si == 0) totM++; else totF++;
                        if (includeCured && isCured)  { if (si == 0) curM++; else curF++; }
                        if (isCompleted) { if (si == 0) comM++; else comF++; }
                        if (isDied)      { if (si == 0) dieM++; else dieF++; }
                        if (isFailed)    { if (si == 0) filM++; else filF++; }
                        if (isLostToFP)  { if (si == 0) lsM++;  else lsF++;  }
                        if (isNotEval)   { if (si == 0) neM++;  else neF++;  }
                    }

                    if      (ptType == 1 && pbc)    AddOutcome(ref toNewPBCM, ref toNewPBCF,
                        ref toNewPBC_CuredM,     ref toNewPBC_CuredF,
                        ref toNewPBC_CompletedM, ref toNewPBC_CompletedF,
                        ref toNewPBC_DiedM,      ref toNewPBC_DiedF,
                        ref toNewPBC_FailedM,    ref toNewPBC_FailedF,
                        ref toNewPBC_LostToFPM,  ref toNewPBC_LostToFPF,
                        ref toNewPBC_NotEvalM,   ref toNewPBC_NotEvalF,  includeCured: true);

                    else if (ptType == 1 && pcdOrEP) AddOutcome(ref toNewPCDEPM, ref toNewPCDEPF,
                        ref toNewPBC_CuredM,         ref toNewPBC_CuredF,  // not used (includeCured:false)
                        ref toNewPCDEP_CompletedM,   ref toNewPCDEP_CompletedF,
                        ref toNewPCDEP_DiedM,        ref toNewPCDEP_DiedF,
                        ref toNewPCDEP_FailedM,      ref toNewPCDEP_FailedF,
                        ref toNewPCDEP_LostToFPM,    ref toNewPCDEP_LostToFPF,
                        ref toNewPCDEP_NotEvalM,     ref toNewPCDEP_NotEvalF, includeCured: false);

                    else if (ptType == 2)            AddOutcome(ref toRelapseM, ref toRelapseF,
                        ref toRelapse_CuredM,    ref toRelapse_CuredF,
                        ref toRelapse_CompletedM, ref toRelapse_CompletedF,
                        ref toRelapse_DiedM,     ref toRelapse_DiedF,
                        ref toRelapse_FailedM,   ref toRelapse_FailedF,
                        ref toRelapse_LostToFPM, ref toRelapse_LostToFPF,
                        ref toRelapse_NotEvalM,  ref toRelapse_NotEvalF, includeCured: true);

                    else if (ptType == 3)
                    {
                        toFailure++;
                        if (isCured)     toFailure_Cured++;
                        if (isCompleted) toFailure_Completed++;
                        if (isDied)      toFailure_Died++;
                        if (isFailed)    toFailure_Failed++;
                        if (isLostToFP)  toFailure_LostToFP++;
                        if (isNotEval)   toFailure_NotEval++;
                    }
                    else if (ptType == 4)
                    {
                        toLostToFP++;
                        if (isCured)     toLostToFP_Cured++;
                        if (isCompleted) toLostToFP_Completed++;
                        if (isDied)      toLostToFP_Died++;
                        if (isFailed)    toLostToFP_Failed++;
                        if (isLostToFP)  toLostToFP_LostToFP++;
                        if (isNotEval)   toLostToFP_NotEval++;
                    }
                    else if (ptType == 6)
                    {
                        toOther++;
                        if (isCured)     toOther_Cured++;
                        if (isCompleted) toOther_Completed++;
                        if (isDied)      toOther_Died++;
                        if (isFailed)    toOther_Failed++;
                        if (isLostToFP)  toOther_LostToFP++;
                        if (isNotEval)   toOther_NotEval++;
                    }

                    // TB/HIV
                    if (hivRes > 0) toTestedHIV++;
                    if (hivRes == 2)
                    {
                        toTestedHIVPos++;
                        if (isCured)     toHIVPos_Cured++;
                        if (isCompleted) toHIVPos_Completed++;
                        if (isDied)      toHIVPos_Died++;
                        if (isFailed)    toHIVPos_Failed++;
                        if (isLostToFP)  toHIVPos_LostToFP++;
                        if (isNotEval)   toHIVPos_NotEval++;
                        if (onART == 1)  toTestedHIVART++;
                        if (onCPT == 1)  toTestedHIVCPT++;
                    }

                    // Children < 15
                    if (age < 15)
                    {
                        toChn++;
                        if (isCured)     toChn_Cured++;
                        if (isCompleted) toChn_Completed++;
                        if (isDied)      toChn_Died++;
                        if (isFailed)    toChn_Failed++;
                        if (isLostToFP)  toChn_LostToFP++;
                        if (isNotEval)   toChn_NotEval++;
                    }

                    // Adolescents 10–19
                    if (age is >= 10 and <= 19)
                    {
                        toAdol++;
                        if (isCured)     toAdol_Cured++;
                        if (isCompleted) toAdol_Completed++;
                        if (isDied)      toAdol_Died++;
                        if (isFailed)    toAdol_Failed++;
                        if (isLostToFP)  toAdol_LostToFP++;
                        if (isNotEval)   toAdol_NotEval++;
                    }
                }
            }

            // Step 5 — Presumptive cases
            await Progress("Counting presumptive TB cases…");
            {
                var p = new Dictionary<string, object>(baseParams)
                {
                    ["@CfStart"] = cfStart.ToDateTime(TimeOnly.MinValue),
                    ["@CfEnd"]   = cfEnd.ToDateTime(TimeOnly.MinValue),
                };
                await using var cmd = new SqlCommand(presumptiveSql, conn);
                foreach (var (k, v) in p) cmd.Parameters.AddWithValue(k, v);
                var result = await cmd.ExecuteScalarAsync(ct);
                cfSuspectsSeen = result is not null and not DBNull ? Convert.ToInt32(result) : 0;
            }

            // Step 6 — Build Excel workbook
            await Progress("Building Excel workbook…");

            var templatePath = Path.Combine(_env.ContentRootPath, "Templates", "Template_DSTB_NTP_Report.xlsx");
            if (!System.IO.File.Exists(templatePath))
            {
                await Emit(new { error = "TB report template not found on server." });
                return;
            }

            var today     = DateTime.Today;

            // Column letters for the 10 NTP age groups in the age-sex tables.
            // Template uses merged sub-total columns at K, M, O — those are skipped.
            string[] agCols = ["D", "E", "F", "G", "H", "I", "J", "L", "N", "P"];

            byte[] excelBytes;
            string fileName;
            try
            {
                await using var ts = new FileStream(templatePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var wb = new XLWorkbook(ts);

                var ws2 = wb.Worksheets.Worksheet(2); // Case Finding
                var ws3 = wb.Worksheets.Worksheet(3); // Sputum Conversion
                var ws4 = wb.Worksheets.Worksheet(4); // Treatment Outcomes
                var ws5 = wb.Worksheets.Worksheet(5); // Treatment Summary

                // ── Sheet 2: Case Finding ───────────────────────────────
                SW(ws2.Cell("D8"), facilityLabel);
                if (cfOrdinal > 0) WriteQuarterOrdinal(ws2.Cell("N8"), cfOrdinal);
                SW(ws2.Cell("Q8"), cfYearStr);
                SW(ws2.Cell("N9"), today.ToString("dd/MM/yyyy"));

                SW(ws2.Cell("I13"), cfPBCNew);    SW(ws2.Cell("K13"), cfPBCRelapse);
                SW(ws2.Cell("M13"), cfPBCPrevTreat); SW(ws2.Cell("O13"), cfPBCOther);
                SW(ws2.Cell("I14"), cfPCDNew);    SW(ws2.Cell("K14"), cfPCDRelapse);
                SW(ws2.Cell("M14"), cfPCDPrevTreat); SW(ws2.Cell("O14"), cfPCDOther);
                SW(ws2.Cell("I15"), cfEPNew);     SW(ws2.Cell("K15"), cfEPRelapse);
                SW(ws2.Cell("M15"), cfEPPrevTreat);  SW(ws2.Cell("O15"), cfEPOther);

                for (int i = 0; i < 10; i++)
                {
                    SW(ws2.Cell($"{agCols[i]}19"), cfPBCNewRelapse[i, 0]); // Male
                    SW(ws2.Cell($"{agCols[i]}20"), cfPBCNewRelapse[i, 1]); // Female
                }

                SW(ws2.Cell("B24"), cfSuspectsSeen);
                SW(ws2.Cell("E24"), cfPBCLab);
                SW(ws2.Cell("I24"), cfTestedHIV);
                SW(ws2.Cell("M24"), cfTestedHIVPos);
                SW(ws2.Cell("O24"), cfTestedHIVART);
                SW(ws2.Cell("Q24"), cfTestedHIVCPT);

                SW(ws2.Cell("J27"), cfGeneXpert);    SW(ws2.Cell("L27"), cfMicroscopy);
                SW(ws2.Cell("N27"), cfTBLam);        SW(ws2.Cell("P27"), cfTrueNat);  SW(ws2.Cell("R27"), cfXray);
                SW(ws2.Cell("J28"), cfGeneXpertPos); SW(ws2.Cell("L28"), cfMicroscopyPos);
                SW(ws2.Cell("N28"), cfTBLam);        SW(ws2.Cell("P28"), cfTrueNatPos); // TB-LAM: positive = tested

                for (int i = 0; i < 10; i++)
                {
                    SW(ws2.Cell($"{agCols[i]}32"), cfHIVPos[i, 0]);    // Male
                    SW(ws2.Cell($"{agCols[i]}33"), cfHIVPos[i, 1]);    // Female
                    SW(ws2.Cell($"{agCols[i]}37"), cfARTHIVPos[i, 0]); // Male on ART
                    SW(ws2.Cell($"{agCols[i]}38"), cfARTHIVPos[i, 1]); // Female on ART
                }

                // ── Sheet 3: Sputum Conversion ──────────────────────────
                SW(ws3.Cell("D8"), facilityLabel);
                if (scOrdinal > 0) WriteQuarterOrdinal(ws3.Cell("L8"), scOrdinal);
                SW(ws3.Cell("P8"), scYearStr);
                SW(ws3.Cell("N9"), today.ToString("dd/MM/yyyy"));

                SW(ws3.Cell("A14"), scNewPBC);
                SW(ws3.Cell("F14"), scSmearND);
                SW(ws3.Cell("J14"), sc2Months);
                SW(ws3.Cell("M14"), sc3Months);

                // ── Sheet 4: Treatment Outcomes ─────────────────────────
                SW(ws4.Cell("D8"), facilityLabel);
                if (toOrdinal > 0) WriteQuarterOrdinal(ws4.Cell("P8"), toOrdinal);
                SW(ws4.Cell("W8"), toYearStr);
                SW(ws4.Cell("P9"), today.ToString("dd/MM/yyyy"));

                // Row 16 — New PBC (M/F split, includes Cured)
                SW(ws4.Cell("H16"), toNewPBCM);        SW(ws4.Cell("I16"), toNewPBCF);
                SW(ws4.Cell("J16"), toNewPBC_CuredM);  SW(ws4.Cell("K16"), toNewPBC_CuredF);
                SW(ws4.Cell("L16"), toNewPBC_CompletedM); SW(ws4.Cell("M16"), toNewPBC_CompletedF);
                SW(ws4.Cell("N16"), toNewPBC_DiedM);   SW(ws4.Cell("O16"), toNewPBC_DiedF);
                SW(ws4.Cell("P16"), toNewPBC_FailedM); SW(ws4.Cell("Q16"), toNewPBC_FailedF);
                SW(ws4.Cell("R16"), toNewPBC_LostToFPM); SW(ws4.Cell("S16"), toNewPBC_LostToFPF);
                SW(ws4.Cell("T16"), toNewPBC_NotEvalM);  SW(ws4.Cell("U16"), toNewPBC_NotEvalF);

                // Row 17 — New PCD/EP (M/F split, no Cured)
                SW(ws4.Cell("H17"), toNewPCDEPM);     SW(ws4.Cell("I17"), toNewPCDEPF);
                SW(ws4.Cell("L17"), toNewPCDEP_CompletedM); SW(ws4.Cell("M17"), toNewPCDEP_CompletedF);
                SW(ws4.Cell("N17"), toNewPCDEP_DiedM);  SW(ws4.Cell("O17"), toNewPCDEP_DiedF);
                SW(ws4.Cell("P17"), toNewPCDEP_FailedM); SW(ws4.Cell("Q17"), toNewPCDEP_FailedF);
                SW(ws4.Cell("R17"), toNewPCDEP_LostToFPM); SW(ws4.Cell("S17"), toNewPCDEP_LostToFPF);
                SW(ws4.Cell("T17"), toNewPCDEP_NotEvalM); SW(ws4.Cell("U17"), toNewPCDEP_NotEvalF);

                // Row 18 — Relapse (M/F split, includes Cured)
                SW(ws4.Cell("H18"), toRelapseM);       SW(ws4.Cell("I18"), toRelapseF);
                SW(ws4.Cell("J18"), toRelapse_CuredM); SW(ws4.Cell("K18"), toRelapse_CuredF);
                SW(ws4.Cell("L18"), toRelapse_CompletedM); SW(ws4.Cell("M18"), toRelapse_CompletedF);
                SW(ws4.Cell("N18"), toRelapse_DiedM);  SW(ws4.Cell("O18"), toRelapse_DiedF);
                SW(ws4.Cell("P18"), toRelapse_FailedM); SW(ws4.Cell("Q18"), toRelapse_FailedF);
                SW(ws4.Cell("R18"), toRelapse_LostToFPM); SW(ws4.Cell("S18"), toRelapse_LostToFPF);
                SW(ws4.Cell("T18"), toRelapse_NotEvalM); SW(ws4.Cell("U18"), toRelapse_NotEvalF);

                // Row 19 — After Failure (no M/F)
                SW(ws4.Cell("G19"), toFailure);
                SW(ws4.Cell("J19"), toFailure_Cured);    SW(ws4.Cell("L19"), toFailure_Completed);
                SW(ws4.Cell("N19"), toFailure_Died);     SW(ws4.Cell("P19"), toFailure_Failed);
                SW(ws4.Cell("R19"), toFailure_LostToFP); SW(ws4.Cell("T19"), toFailure_NotEval);

                // Row 20 — Treatment Interrupted / Lost To FP (no M/F)
                SW(ws4.Cell("G20"), toLostToFP);
                SW(ws4.Cell("J20"), toLostToFP_Cured);    SW(ws4.Cell("L20"), toLostToFP_Completed);
                SW(ws4.Cell("N20"), toLostToFP_Died);     SW(ws4.Cell("P20"), toLostToFP_Failed);
                SW(ws4.Cell("R20"), toLostToFP_LostToFP); SW(ws4.Cell("T20"), toLostToFP_NotEval);

                // Row 21 — Other (no M/F)
                SW(ws4.Cell("G21"), toOther);
                SW(ws4.Cell("J21"), toOther_Cured);    SW(ws4.Cell("L21"), toOther_Completed);
                SW(ws4.Cell("N21"), toOther_Died);     SW(ws4.Cell("P21"), toOther_Failed);
                SW(ws4.Cell("R21"), toOther_LostToFP); SW(ws4.Cell("T21"), toOther_NotEval);

                // Row 26 — TB/HIV activities
                SW(ws4.Cell("E26"), toTestedHIV);
                SW(ws4.Cell("I26"), toTestedHIVPos);
                SW(ws4.Cell("P26"), toTestedHIVART);
                SW(ws4.Cell("V26"), toTestedHIVCPT);

                // Row 31 — HIV+ treatment outcomes
                SW(ws4.Cell("G31"), toTestedHIVPos);
                SW(ws4.Cell("J31"), toHIVPos_Cured);    SW(ws4.Cell("L31"), toHIVPos_Completed);
                SW(ws4.Cell("N31"), toHIVPos_Died);     SW(ws4.Cell("P31"), toHIVPos_Failed);
                SW(ws4.Cell("R31"), toHIVPos_LostToFP); SW(ws4.Cell("T31"), toHIVPos_NotEval);

                // Row 36 — Children (<15)
                SW(ws4.Cell("G36"), toChn);
                SW(ws4.Cell("J36"), toChn_Cured);    SW(ws4.Cell("L36"), toChn_Completed);
                SW(ws4.Cell("N36"), toChn_Died);     SW(ws4.Cell("P36"), toChn_Failed);
                SW(ws4.Cell("R36"), toChn_LostToFP); SW(ws4.Cell("T36"), toChn_NotEval);

                // Row 41 — Adolescents (10–19)
                SW(ws4.Cell("G41"), toAdol);
                SW(ws4.Cell("J41"), toAdol_Cured);    SW(ws4.Cell("L41"), toAdol_Completed);
                SW(ws4.Cell("N41"), toAdol_Died);     SW(ws4.Cell("P41"), toAdol_Failed);
                SW(ws4.Cell("R41"), toAdol_LostToFP); SW(ws4.Cell("T41"), toAdol_NotEval);

                // ── Sheet 5: Treatment Summary (header only) ────────────
                SW(ws5.Cell("D8"), facilityLabel);
                if (toOrdinal > 0) WriteQuarterOrdinal(ws5.Cell("N8"), toOrdinal);
                SW(ws5.Cell("Q8"), toYearStr);
                SW(ws5.Cell("N9"), today.ToString("dd/MM/yyyy"));

                using var ms = new MemoryStream();
                wb.SaveAs(ms);
                excelBytes = ms.ToArray();
                fileName   = $"{geoFilePrefix}_TB_NTP_{periodLabel}_{cfYearStr}_SV.xlsx";
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error building TB Quarterly Excel workbook.");
                try { await Emit(new { error = $"Failed to build Excel: {ex.GetType().Name}: {ex.Message}" }); } catch { }
                return;
            }

            // Step 7 — Cache and signal done
            step++;
            var token = Guid.NewGuid().ToString("N");
            _cache.Set(token, new ReportCacheEntry(excelBytes, fileName),
                new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });
            await Emit(new { done = true, token, filename = fileName, step, total = totalSteps });
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in TB Quarterly SSE report data collection.");
            try { await Emit(new { error = $"Data query failed: {ex.GetType().Name}: {ex.Message}" }); } catch { }
            return;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/tb-quarterly-download?token=<token>
    //
    //  One-time download endpoint: retrieves the Excel file prepared by
    //  tb-quarterly-progress and cached in IMemoryCache.
    //  The token is consumed (removed) on first use.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("tb-quarterly-download")]
    public IActionResult TbQuarterlyDownload([FromQuery] string token)
    {
        if (string.IsNullOrEmpty(token) || !Guid.TryParseExact(token, "N", out _))
            return BadRequest(new { error = "Invalid or missing download token." });

        if (!_cache.TryGetValue(token, out ReportCacheEntry? entry) || entry is null)
            return NotFound(new { error = "Download token has expired or was not found. Please regenerate the report." });

        _cache.Remove(token);
        return File(entry.Bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            entry.Filename);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/tb-lfa-progress
    //      ?cfStartDate=2026-01-01&cfEndDate=2026-03-31[&facilityIds[]=n...]
    //
    //  Streams SSE progress events while querying the eTBr database per
    //  facility and building the DS-TB LFA Verification Excel workbook.
    //  One CF row and one TO row is written per facility, matching the
    //  layout of the original eTBr Web Forms lfa.aspx report.
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("tb-lfa-progress")]
    public async Task TbLfaProgress(
        [FromQuery] string cfStartDate,
        [FromQuery] string cfEndDate,
        [FromQuery] int[]? facilityIds = null)
    {
        var ct = HttpContext.RequestAborted;

        // ── Input validation ─────────────────────────────────────────────
        if (!DateOnly.TryParse(cfStartDate, out var cfStart))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfStartDate is not a valid date." }); return; }
        if (!DateOnly.TryParse(cfEndDate, out var cfEnd))
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfEndDate is not a valid date." }); return; }
        if (cfEnd < cfStart)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "cfEndDate must be on or after cfStartDate." }); return; }

        // ── Derive period ─────────────────────────────────────────────────
        int periodMonths = (cfEnd.Year - cfStart.Year) * 12 + cfEnd.Month - cfStart.Month + 1;
        // TO cohort: same quarter/period one year before CF
        var toStart = cfStart.AddMonths(-12);
        var toEnd   = cfEnd.AddMonths(-12);

        int cfOrdinal = periodMonths switch { 3 => (cfStart.Month - 1) / 3 + 1, 6 => cfStart.Month <= 6 ? 1 : 2, _ => 0 };
        int toOrdinal = periodMonths switch { 3 => (toStart.Month - 1) / 3 + 1, 6 => toStart.Month <= 6 ? 1 : 2, _ => 0 };
        string cfYearStr    = cfStart.Year.ToString();
        string toYearStr    = toStart.Year.ToString();
        string cfQuarterStr = cfOrdinal > 0 ? cfOrdinal.ToString() : "1";
        string toQuarterStr = toOrdinal > 0 ? toOrdinal.ToString() : "1";

        string cfSheetName = periodMonths switch
        {
            3  => $"CF Q{cfOrdinal} {cfYearStr}",
            6  => $"CF {(cfOrdinal == 1 ? "S1" : "S2")} {cfYearStr}",
            _  => $"CF {cfYearStr}",
        };
        string toSheetName = periodMonths switch
        {
            3  => $"TO Q{toOrdinal} {toYearStr}",
            6  => $"TO {(toOrdinal == 1 ? "S1" : "S2")} {toYearStr}",
            _  => $"TO {toYearStr}",
        };
        string periodLabel = periodMonths switch { 3 => $"Q{cfOrdinal}", 6 => $"H{cfOrdinal}", _ => "Annual" };

        var callerName = User.FindFirstValue(ClaimTypes.Name) ?? User.FindFirstValue("sub") ?? "unknown";
        _logger.LogInformation(
            "TB LFA Report (SSE) requested by {User} — CF={CfStart}–{CfEnd}, TO={ToStart}–{ToEnd}, facilityIds=[{FacIds}]",
            callerName, cfStart, cfEnd, toStart, toEnd, string.Join(",", facilityIds ?? []));

        // ── JWT scope ─────────────────────────────────────────────────────
        bool isNgo   = User.IsInRole("NGO");
        bool isZonal = User.IsInRole("StateCoordinator");
        bool isDtls  = User.IsInRole("CountySupervisor");
        int.TryParse(User.FindFirstValue("facility_id"), out var userFacilityId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),  out var userSubRecId);
        int.TryParse(User.FindFirstValue("location_id"), out var userLocationId);

        if (userFacilityId > 0)
            facilityIds = [userFacilityId];

        var cleanFacIds   = (facilityIds ?? []).Where(id => id > 0).Distinct().ToArray();
        var geoConditions = new List<string>();
        var baseParams    = new Dictionary<string, object>();

        if (cleanFacIds.Length > 0)
        {
            var pNames = cleanFacIds.Select((_, i) => $"@FacId{i}");
            geoConditions.Add($"hf.HealthFacilityID IN ({string.Join(", ", pNames)})");
            for (int i = 0; i < cleanFacIds.Length; i++)
                baseParams[$"@FacId{i}"] = cleanFacIds[i];
        }
        if (isNgo && userSubRecId > 0)
        {
            geoConditions.Add("hf.SubRecID = @SubRecId");
            baseParams["@SubRecId"] = userSubRecId;
            if ((isZonal || isDtls) && userLocationId > 0)
            {
                geoConditions.Add("hf.LocationID = @LocationId");
                baseParams["@LocationId"] = userLocationId;
            }
        }
        var geoAnd = geoConditions.Count > 0
            ? "AND " + string.Join(" AND ", geoConditions)
            : string.Empty;

        // ── Facilities query (run before SSE so 400 is still possible) ────
        var facilitiesSql = $"""
            SELECT hf.HealthFacilityID, COALESCE(sr.SubRec, '') AS SubRec,
                   c.County, hf.HealthFacility
            FROM   HealthFacilityT hf
            INNER  JOIN CountyT  c  ON c.CountyID   = hf.CountyID
            LEFT   JOIN SubRecT  sr ON sr.SubRecID  = hf.SubRecID
            WHERE  1=1 {geoAnd}
            ORDER  BY sr.SubRec, c.County, hf.HealthFacility
            """;

        List<(int Id, string SubRec, string County, string FacilityName)> facilities;
        try
        {
            await using var connCheck = new SqlConnection(_connectionString);
            await connCheck.OpenAsync(ct);
            await using var cmdF = new SqlCommand(facilitiesSql, connCheck);
            foreach (var (k, v) in baseParams) cmdF.Parameters.AddWithValue(k, v);
            facilities = new();
            await using var rsF = await cmdF.ExecuteReaderAsync(ct);
            while (await rsF.ReadAsync(ct))
                facilities.Add((rsF.GetInt32(0), rsF.GetString(1), rsF.GetString(2), rsF.GetString(3)));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resolving facilities in tb-lfa-progress");
            Response.StatusCode = 500;
            await Response.WriteAsJsonAsync(new { error = "Failed to resolve facility list." });
            return;
        }

        if (facilities.Count == 0)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "No accessible facilities match the selection." }); return; }

        string templatePath = Path.Combine(_env.ContentRootPath, "Templates", "Template_LFA_Verification_Report.xlsx");
        if (!System.IO.File.Exists(templatePath))
        { Response.StatusCode = 500; await Response.WriteAsJsonAsync(new { error = "LFA report template not found on server." }); return; }

        // ── SSE setup ─────────────────────────────────────────────────────
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.Append("Cache-Control", "no-cache, no-store");
        Response.Headers.Append("X-Accel-Buffering", "no");
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        // 1 step per facility + 1 for build/finalise
        int totalSteps = facilities.Count + 1;
        int step = 0;

        async Task Emit(object payload)
        {
            var json = JsonSerializer.Serialize(payload, SseJsonOptions);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        async Task Progress(string label)
        {
            step++;
            await Emit(new { step, total = totalSteps, label });
        }

        // ── Local helpers ─────────────────────────────────────────────────
        static bool LfaIsSmearPos(int r) => r is 1 or 4 or 5 or 6;
        static bool LfaIsXpertPos(int r) => r is 3 or 4 or 5;
        static bool LfaIsTbPBC(int tbType, int lab, int xpert) =>
            tbType == 1 && (LfaIsSmearPos(lab) || LfaIsXpertPos(xpert));
        static int LfaAg(int age) => age switch
        {
            < 5  => 0, < 10 => 1, < 15 => 2, < 20 => 3, < 25 => 4,
            < 35 => 5, < 45 => 6, < 55 => 7, < 65 => 8, _   => 9,
        };

        // Column arrays for 10 LFA age groups (0=<5 … 9=65+)
        string[] cfAgColsM  = ["V",  "W",  "X",  "Y",  "Z",  "AA", "AB", "AC", "AD", "AE"];
        string[] cfAgColsF  = ["AF", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AN", "AO"];
        string[] hivAgColsM = ["BC", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BK", "BL"];
        string[] hivAgColsF = ["BM", "BN", "BO", "BP", "BQ", "BR", "BS", "BT", "BU", "BV"];
        string[] artAgColsM = ["CE", "CF", "CG", "CH", "CI", "CJ", "CK", "CL", "CM", "CN"];
        string[] artAgColsF = ["CO", "CP", "CQ", "CR", "CS", "CT", "CU", "CV", "CW", "CX"];

        // Per-facility SQL (no geo scope needed — facility comes from scope-filtered list)
        const string cfSqlPf = """
            SELECT
                pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age, pd.DiagMethodID,
                COALESCE(fu.Mon0LabResultID,0)   AS Mon0LabResultID,
                COALESCE(fu.Mon0XpertResultID,0) AS Mon0XpertResultID,
                COALESCE(fu.HIVTestResultID,0)   AS HIVTestResultID,
                COALESCE(fu.OnART,0)             AS OnART,
                COALESCE(fu.OnCPT,0)             AS OnCPT
            FROM PtDetailsT pd
            LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pd.NearestHFID
            WHERE pd.Deleted = 0
              AND pd.PtTypeID IN (1, 2, 3, 4, 6)
              AND pd.RegDate BETWEEN @CfStart AND @CfEnd
              AND hf.HealthFacilityID = @FacilityId
            """;

        const string toSqlPf = """
            SELECT
                pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age,
                COALESCE(fu.Mon0LabResultID,0)   AS Mon0LabResultID,
                COALESCE(fu.Mon0XpertResultID,0) AS Mon0XpertResultID,
                COALESCE(fu.HIVTestResultID,0)   AS HIVTestResultID,
                COALESCE(fu.OnART,0)             AS OnART,
                COALESCE(fu.OutcomeID,0)         AS OutcomeID
            FROM PtDetailsT pd
            LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pd.NearestHFID
            WHERE pd.Deleted = 0
              AND pd.PtTypeID IN (1, 2, 3, 4, 6)
              AND pd.RegDate BETWEEN @ToStart AND @ToEnd
              AND hf.HealthFacilityID = @FacilityId
            """;

        const string presumptiveSqlPf = """
            SELECT COALESCE(SUM(pc.PresumptiveCase), 0) AS Total
            FROM PresumptiveCaseT pc
            JOIN YearT y ON y.YearID = pc.YearID
            JOIN HealthFacilityT hf ON hf.HealthFacilityID = pc.NearestHFID
            WHERE pc.MonthID IS NOT NULL
              AND pc.YearID  IS NOT NULL
              AND DATEFROMPARTS(y.YearName, pc.MonthID, 15) BETWEEN @CfStart AND @CfEnd
              AND hf.HealthFacilityID = @FacilityId
            """;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync(ct);

            await using var ts = new FileStream(templatePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var wb = new XLWorkbook(ts);
            var ws = wb.Worksheet("casefinding");
            var wo = wb.Worksheet("outcome");
            ws.Name = cfSheetName;
            wo.Name = toSheetName;

            int counter = 3; // first data row will be counter+1 = 4

            // ── Per-facility loop ─────────────────────────────────────────
            foreach (var (facId, subRec, county, facilityName) in facilities)
            {
                await Progress($"Processing {facilityName}…");
                counter++;

                // CF counters
                int cfPBCNew = 0, cfPBCRelapse = 0, cfPBCPrevTreat = 0, cfPBCOther = 0;
                int cfPCDNew = 0, cfPCDRelapse = 0, cfPCDPrevTreat = 0, cfPCDOther = 0;
                int cfEPNew  = 0, cfEPRelapse  = 0, cfEPPrevTreat  = 0, cfEPOther  = 0;
                int cfSuspectsSeen = 0, cfPBCLab = 0;
                int cfTestedHIV = 0, cfTestedHIVPos = 0, cfTestedHIVART = 0, cfTestedHIVCPT = 0;
                int cfGeneXpert = 0, cfMicroscopy = 0, cfTBLam = 0, cfTrueNat = 0, cfXray = 0;
                int cfGeneXpertPos = 0, cfMicroscopyPos = 0, cfTrueNatPos = 0;
                int[,] cfPBCNewRelapse = new int[10, 2];
                int[,] cfHIVPos        = new int[10, 2];
                int[,] cfARTHIVPos     = new int[10, 2];

                // CF query
                {
                    await using var cmd = new SqlCommand(cfSqlPf, conn);
                    cmd.CommandTimeout = 120;
                    cmd.Parameters.AddWithValue("@CfStart",    cfStart.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@CfEnd",      cfEnd.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@FacilityId", facId);
                    await using var rdr = await cmd.ExecuteReaderAsync(ct);
                    while (await rdr.ReadAsync(ct))
                    {
                        int ptType   = rdr.GetInt32(rdr.GetOrdinal("PtTypeID"));
                        int tbType   = rdr.GetInt32(rdr.GetOrdinal("TbTypeID"));
                        int sexId    = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                        int age      = rdr.IsDBNull(rdr.GetOrdinal("Age")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("Age"));
                        int diagMeth = rdr.GetInt32(rdr.GetOrdinal("DiagMethodID"));
                        int lab      = rdr.GetInt32(rdr.GetOrdinal("Mon0LabResultID"));
                        int xpert    = rdr.GetInt32(rdr.GetOrdinal("Mon0XpertResultID"));
                        int hivRes   = rdr.GetInt32(rdr.GetOrdinal("HIVTestResultID"));
                        int onART    = rdr.GetInt32(rdr.GetOrdinal("OnART"));
                        int onCPT    = rdr.GetInt32(rdr.GetOrdinal("OnCPT"));

                        bool pbc = LfaIsTbPBC(tbType, lab, xpert);
                        bool pcd = !pbc && tbType == 1;
                        bool ep  = tbType == 3;
                        int  si  = sexId == 2 ? 1 : 0;
                        int  ag  = LfaAg(age);

                        if (pbc)
                        {
                            if      (ptType == 1)         cfPBCNew++;
                            else if (ptType == 2)         cfPBCRelapse++;
                            else if (ptType is 3 or 4)    cfPBCPrevTreat++;
                            else if (ptType == 6)         cfPBCOther++;
                        }
                        else if (pcd)
                        {
                            if      (ptType == 1)         cfPCDNew++;
                            else if (ptType == 2)         cfPCDRelapse++;
                            else if (ptType is 3 or 4)    cfPCDPrevTreat++;
                            else if (ptType == 6)         cfPCDOther++;
                        }
                        else if (ep)
                        {
                            if      (ptType == 1)         cfEPNew++;
                            else if (ptType == 2)         cfEPRelapse++;
                            else if (ptType is 3 or 4)    cfEPPrevTreat++;
                            else if (ptType == 6)         cfEPOther++;
                        }

                        if (pbc) cfPBCLab++;
                        if (pbc && ptType is 1 or 2) cfPBCNewRelapse[ag, si]++;

                        // Diagnostic method counts — new and relapse cases only
                        if (ptType is 1 or 2)
                        {
                            switch (diagMeth)
                            {
                                case 1: cfGeneXpert++;  if (LfaIsXpertPos(xpert)) cfGeneXpertPos++; break;
                                case 2: cfMicroscopy++; if (LfaIsSmearPos(lab))   cfMicroscopyPos++; break;
                                case 3: cfTBLam++;      break;
                                case 4: cfTrueNat++;    if (LfaIsXpertPos(xpert)) cfTrueNatPos++; break;
                                case 5: cfXray++;       break;
                            }
                        }

                        if (hivRes > 0) cfTestedHIV++;
                        if (hivRes == 2)
                        {
                            cfTestedHIVPos++;
                            cfHIVPos[ag, si]++;
                            if (onART == 1) { cfTestedHIVART++; cfARTHIVPos[ag, si]++; }
                            if (onCPT == 1)  cfTestedHIVCPT++;
                        }
                    }
                }

                // Presumptive cases
                {
                    await using var cmd = new SqlCommand(presumptiveSqlPf, conn);
                    cmd.Parameters.AddWithValue("@CfStart",    cfStart.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@CfEnd",      cfEnd.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@FacilityId", facId);
                    var result = await cmd.ExecuteScalarAsync(ct);
                    cfSuspectsSeen = result is not null and not DBNull ? Convert.ToInt32(result) : 0;
                }

                // TO counters
                int toNewPBCM = 0, toNewPBCF = 0;
                int toNewPBC_CuredM = 0,      toNewPBC_CuredF = 0;
                int toNewPBC_CompletedM = 0,  toNewPBC_CompletedF = 0;
                int toNewPBC_DiedM = 0,       toNewPBC_DiedF = 0;
                int toNewPBC_FailedM = 0,     toNewPBC_FailedF = 0;
                int toNewPBC_LostToFPM = 0,   toNewPBC_LostToFPF = 0;
                int toNewPBC_NotEvalM = 0,    toNewPBC_NotEvalF = 0;

                int toNewPCDEPM = 0, toNewPCDEPF = 0;
                int toNewPCDEP_CompletedM = 0, toNewPCDEP_CompletedF = 0;
                int toNewPCDEP_DiedM = 0,      toNewPCDEP_DiedF = 0;
                int toNewPCDEP_FailedM = 0,    toNewPCDEP_FailedF = 0;
                int toNewPCDEP_LostToFPM = 0,  toNewPCDEP_LostToFPF = 0;
                int toNewPCDEP_NotEvalM = 0,   toNewPCDEP_NotEvalF = 0;

                int toRelapseM = 0, toRelapseF = 0;
                int toRelapse_CuredM = 0,     toRelapse_CuredF = 0;
                int toRelapse_CompletedM = 0, toRelapse_CompletedF = 0;
                int toRelapse_DiedM = 0,      toRelapse_DiedF = 0;
                int toRelapse_FailedM = 0,    toRelapse_FailedF = 0;
                int toRelapse_LostToFPM = 0,  toRelapse_LostToFPF = 0;
                int toRelapse_NotEvalM = 0,   toRelapse_NotEvalF = 0;

                int toTestedHIV = 0, toTestedHIVPos = 0, toTestedHIVART = 0;
                int toHIVPos_Cured = 0, toHIVPos_Completed = 0, toHIVPos_Died = 0;
                int toHIVPos_Failed = 0, toHIVPos_LostToFP = 0, toHIVPos_NotEval = 0;
                int toChn = 0,   toChn_Cured = 0,   toChn_Completed = 0,
                    toChn_Died = 0, toChn_Failed = 0, toChn_LostToFP = 0, toChn_NotEval = 0;
                int toAdol = 0,  toAdol_Cured = 0,  toAdol_Completed = 0,
                    toAdol_Died = 0, toAdol_Failed = 0, toAdol_LostToFP = 0, toAdol_NotEval = 0;

                // TO query
                {
                    await using var cmd = new SqlCommand(toSqlPf, conn);
                    cmd.CommandTimeout = 120;
                    cmd.Parameters.AddWithValue("@ToStart",    toStart.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@ToEnd",      toEnd.ToDateTime(TimeOnly.MinValue));
                    cmd.Parameters.AddWithValue("@FacilityId", facId);
                    await using var rdr = await cmd.ExecuteReaderAsync(ct);
                    while (await rdr.ReadAsync(ct))
                    {
                        int ptType  = rdr.GetInt32(rdr.GetOrdinal("PtTypeID"));
                        int tbType  = rdr.GetInt32(rdr.GetOrdinal("TbTypeID"));
                        int sexId   = rdr.GetInt32(rdr.GetOrdinal("SexID"));
                        int age     = rdr.IsDBNull(rdr.GetOrdinal("Age")) ? 0 : rdr.GetInt32(rdr.GetOrdinal("Age"));
                        int lab     = rdr.GetInt32(rdr.GetOrdinal("Mon0LabResultID"));
                        int xpert   = rdr.GetInt32(rdr.GetOrdinal("Mon0XpertResultID"));
                        int hivRes  = rdr.GetInt32(rdr.GetOrdinal("HIVTestResultID"));
                        int onART   = rdr.GetInt32(rdr.GetOrdinal("OnART"));
                        int outcome = rdr.GetInt32(rdr.GetOrdinal("OutcomeID"));

                        bool pbc   = LfaIsTbPBC(tbType, lab, xpert);
                        bool pcdEP = !pbc && (tbType == 1 || tbType == 3);
                        int  si    = sexId == 2 ? 1 : 0;

                        bool isCured     = outcome == 1;
                        bool isCompleted = outcome == 2;
                        bool isDied      = outcome == 3;
                        bool isFailed    = outcome == 4;
                        bool isLostToFP  = outcome == 5;
                        bool isNotEval   = outcome is 6 or 0;

                        if (ptType == 1 && pbc)
                        {
                            if (si == 0) { toNewPBCM++; if (isCured) toNewPBC_CuredM++; if (isCompleted) toNewPBC_CompletedM++; if (isDied) toNewPBC_DiedM++; if (isFailed) toNewPBC_FailedM++; if (isLostToFP) toNewPBC_LostToFPM++; if (isNotEval) toNewPBC_NotEvalM++; }
                            else         { toNewPBCF++; if (isCured) toNewPBC_CuredF++; if (isCompleted) toNewPBC_CompletedF++; if (isDied) toNewPBC_DiedF++; if (isFailed) toNewPBC_FailedF++; if (isLostToFP) toNewPBC_LostToFPF++; if (isNotEval) toNewPBC_NotEvalF++; }
                        }
                        else if (ptType == 1 && pcdEP)
                        {
                            if (si == 0) { toNewPCDEPM++; if (isCompleted) toNewPCDEP_CompletedM++; if (isDied) toNewPCDEP_DiedM++; if (isFailed) toNewPCDEP_FailedM++; if (isLostToFP) toNewPCDEP_LostToFPM++; if (isNotEval) toNewPCDEP_NotEvalM++; }
                            else         { toNewPCDEPF++; if (isCompleted) toNewPCDEP_CompletedF++; if (isDied) toNewPCDEP_DiedF++; if (isFailed) toNewPCDEP_FailedF++; if (isLostToFP) toNewPCDEP_LostToFPF++; if (isNotEval) toNewPCDEP_NotEvalF++; }
                        }
                        else if (ptType == 2)
                        {
                            if (si == 0) { toRelapseM++; if (isCured) toRelapse_CuredM++; if (isCompleted) toRelapse_CompletedM++; if (isDied) toRelapse_DiedM++; if (isFailed) toRelapse_FailedM++; if (isLostToFP) toRelapse_LostToFPM++; if (isNotEval) toRelapse_NotEvalM++; }
                            else         { toRelapseF++; if (isCured) toRelapse_CuredF++; if (isCompleted) toRelapse_CompletedF++; if (isDied) toRelapse_DiedF++; if (isFailed) toRelapse_FailedF++; if (isLostToFP) toRelapse_LostToFPF++; if (isNotEval) toRelapse_NotEvalF++; }
                        }

                        if (hivRes > 0) toTestedHIV++;
                        if (hivRes == 2)
                        {
                            toTestedHIVPos++;
                            if (isCured)     toHIVPos_Cured++;
                            if (isCompleted) toHIVPos_Completed++;
                            if (isDied)      toHIVPos_Died++;
                            if (isFailed)    toHIVPos_Failed++;
                            if (isLostToFP)  toHIVPos_LostToFP++;
                            if (isNotEval)   toHIVPos_NotEval++;
                            if (onART == 1)  toTestedHIVART++;
                        }

                        if (age < 15)
                        {
                            toChn++;
                            if (isCured)     toChn_Cured++;
                            if (isCompleted) toChn_Completed++;
                            if (isDied)      toChn_Died++;
                            if (isFailed)    toChn_Failed++;
                            if (isLostToFP)  toChn_LostToFP++;
                            if (isNotEval)   toChn_NotEval++;
                        }

                        if (age is >= 10 and <= 19)
                        {
                            toAdol++;
                            if (isCured)     toAdol_Cured++;
                            if (isCompleted) toAdol_Completed++;
                            if (isDied)      toAdol_Died++;
                            if (isFailed)    toAdol_Failed++;
                            if (isLostToFP)  toAdol_LostToFP++;
                            if (isNotEval)   toAdol_NotEval++;
                        }
                    }
                }

                // ── Write CF row ────────────────────────────────────────────
                ws.Cell($"A{counter}").Value = counter - 3;
                ws.Cell($"B{counter}").Value = subRec;
                ws.Cell($"C{counter}").Value = county;
                ws.Cell($"D{counter}").Value = facilityName;
                ws.Cell($"E{counter}").Value = cfYearStr;
                ws.Cell($"F{counter}").Value = cfQuarterStr;

                ws.Cell($"G{counter}").Value = cfPBCNew;      ws.Cell($"H{counter}").Value = cfPBCRelapse;
                ws.Cell($"I{counter}").Value = cfPBCPrevTreat; ws.Cell($"J{counter}").Value = cfPBCOther;
                ws.Cell($"K{counter}").Value = cfPCDNew;      ws.Cell($"L{counter}").Value = cfPCDRelapse;
                ws.Cell($"M{counter}").Value = cfPCDPrevTreat; ws.Cell($"N{counter}").Value = cfPCDOther;
                ws.Cell($"O{counter}").Value = cfEPNew;       ws.Cell($"P{counter}").Value = cfEPRelapse;
                ws.Cell($"Q{counter}").Value = cfEPPrevTreat;  ws.Cell($"R{counter}").Value = cfEPOther;
                ws.Cell($"S{counter}").Value = cfPBCNew + cfPCDNew + cfEPNew;
                ws.Cell($"T{counter}").Value = cfPBCRelapse + cfPCDRelapse + cfEPRelapse;
                ws.Cell($"U{counter}").Value = (cfPBCNew + cfPCDNew + cfEPNew) + (cfPBCRelapse + cfPCDRelapse + cfEPRelapse);

                for (int i = 0; i < 10; i++)
                {
                    ws.Cell($"{cfAgColsM[i]}{counter}").Value = cfPBCNewRelapse[i, 0];
                    ws.Cell($"{cfAgColsF[i]}{counter}").Value = cfPBCNewRelapse[i, 1];
                }

                ws.Cell($"AP{counter}").Value = cfSuspectsSeen;
                ws.Cell($"AQ{counter}").Value = cfPBCLab;

                ws.Cell($"AR{counter}").Value = cfGeneXpert;
                ws.Cell($"AS{counter}").Value = cfMicroscopy;
                ws.Cell($"AT{counter}").Value = cfTBLam;
                ws.Cell($"AU{counter}").Value = cfTrueNat;
                ws.Cell($"AV{counter}").Value = cfXray;
                ws.Cell($"AW{counter}").FormulaA1 = $"=SUM(AR{counter}+AT{counter}+AU{counter})";
                ws.Cell($"AX{counter}").FormulaA1 =
                    $"=IF(SUM(AR{counter}:AV{counter})=0,0,AW{counter}/SUM(AR{counter}:AV{counter}))";
                ws.Cell($"AX{counter}").Style.NumberFormat.Format = "0.0%";
                ws.Cell($"AY{counter}").Value = cfGeneXpertPos;
                ws.Cell($"AZ{counter}").Value = cfMicroscopyPos;
                ws.Cell($"BA{counter}").Value = cfTBLam; // TB-LAM count intentional (matches reference)
                ws.Cell($"BB{counter}").Value = cfTrueNatPos;

                for (int i = 0; i < 10; i++)
                {
                    ws.Cell($"{hivAgColsM[i]}{counter}").Value = cfHIVPos[i, 0];
                    ws.Cell($"{hivAgColsF[i]}{counter}").Value = cfHIVPos[i, 1];
                }

                ws.Cell($"BW{counter}").Value = cfTestedHIV;
                ws.Cell($"BX{counter}").Value = cfTestedHIVPos;
                ws.Cell($"BY{counter}").Value = cfTestedHIVART;
                ws.Cell($"BZ{counter}").Value = cfTestedHIVCPT;

                ws.Cell($"CA{counter}").FormulaA1 = $"=SUM(V{counter}:AO{counter})";
                ws.Cell($"CB{counter}").FormulaA1 = $"=CA{counter}-U{counter}";
                ws.Cell($"CC{counter}").FormulaA1 = $"=IF(CA{counter}=0,0,BW{counter}/CA{counter})";
                ws.Cell($"CC{counter}").Style.NumberFormat.Format = "0.0%";
                ws.Cell($"CD{counter}").FormulaA1 =
                    $"=IF(AND(BY{counter}=0,BX{counter}=0),\"NA\",IF(BX{counter}=0,0,BY{counter}/BX{counter}))";
                ws.Cell($"CD{counter}").Style.NumberFormat.Format = "0.0%";

                for (int i = 0; i < 10; i++)
                {
                    ws.Cell($"{artAgColsM[i]}{counter}").Value = cfARTHIVPos[i, 0];
                    ws.Cell($"{artAgColsF[i]}{counter}").Value = cfARTHIVPos[i, 1];
                }

                // ── Write TO row ────────────────────────────────────────────
                int toRow = counter + 1;
                wo.Cell($"A{toRow}").Value = counter - 3;
                wo.Cell($"B{toRow}").Value = subRec;
                wo.Cell($"C{toRow}").Value = county;
                wo.Cell($"D{toRow}").Value = facilityName;
                wo.Cell($"E{toRow}").Value = toYearStr;
                wo.Cell($"F{toRow}").Value = toQuarterStr;

                wo.Cell($"G{toRow}").Value =
                    (toNewPBCM + toNewPCDEPM + toRelapseM) + (toNewPBCF + toNewPCDEPF + toRelapseF);
                wo.Cell($"H{toRow}").Value =
                    (toNewPBC_CuredM + toRelapse_CuredM) +
                    (toNewPBC_CompletedM + toNewPCDEP_CompletedM + toRelapse_CompletedM) +
                    (toNewPBC_CuredF + toRelapse_CuredF) +
                    (toNewPBC_CompletedF + toNewPCDEP_CompletedF + toRelapse_CompletedF);
                wo.Cell($"I{toRow}").Value =
                    (toNewPBC_DiedM + toNewPCDEP_DiedM + toRelapse_DiedM) +
                    (toNewPBC_DiedF + toNewPCDEP_DiedF + toRelapse_DiedF);
                wo.Cell($"J{toRow}").Value =
                    (toNewPBC_FailedM + toNewPCDEP_FailedM + toRelapse_FailedM) +
                    (toNewPBC_FailedF + toNewPCDEP_FailedF + toRelapse_FailedF);
                wo.Cell($"K{toRow}").Value =
                    (toNewPBC_LostToFPM + toNewPCDEP_LostToFPM + toRelapse_LostToFPM) +
                    (toNewPBC_LostToFPF + toNewPCDEP_LostToFPF + toRelapse_LostToFPF);
                wo.Cell($"L{toRow}").Value =
                    (toNewPBC_NotEvalM + toNewPCDEP_NotEvalM + toRelapse_NotEvalM) +
                    (toNewPBC_NotEvalF + toNewPCDEP_NotEvalF + toRelapse_NotEvalF);
                wo.Cell($"M{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"M{toRow}").FormulaA1 = $"=IFERROR(IF(G{toRow}=0,0,H{toRow}/G{toRow}),0)";

                wo.Cell($"N{toRow}").Value = toTestedHIV;
                wo.Cell($"O{toRow}").Value = toTestedHIVPos;
                wo.Cell($"P{toRow}").Value = toTestedHIVART;
                wo.Cell($"Q{toRow}").Value = toTestedHIVPos; // HIV+ denominator
                wo.Cell($"R{toRow}").Value = toHIVPos_Cured + toHIVPos_Completed;
                wo.Cell($"S{toRow}").Value = toHIVPos_Died;
                wo.Cell($"T{toRow}").Value = toHIVPos_Failed;
                wo.Cell($"U{toRow}").Value = toHIVPos_LostToFP;
                wo.Cell($"V{toRow}").Value = toHIVPos_NotEval;
                wo.Cell($"W{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"W{toRow}").FormulaA1 = $"=IFERROR(IF(Q{toRow}=0,0,R{toRow}/Q{toRow}),0)";

                wo.Cell($"X{toRow}").Value  = toChn;
                wo.Cell($"Y{toRow}").Value  = toChn_Cured + toChn_Completed;
                wo.Cell($"Z{toRow}").Value  = toChn_Died;
                wo.Cell($"AA{toRow}").Value = toChn_Failed;
                wo.Cell($"AB{toRow}").Value = toChn_LostToFP;
                wo.Cell($"AC{toRow}").Value = toChn_NotEval;
                wo.Cell($"AD{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"AD{toRow}").FormulaA1 = $"=IFERROR(IF(X{toRow}=0,0,Y{toRow}/X{toRow}),0)";

                wo.Cell($"AE{toRow}").Value = toAdol;
                wo.Cell($"AF{toRow}").Value = toAdol_Cured + toAdol_Completed;
                wo.Cell($"AG{toRow}").Value = toAdol_Died;
                wo.Cell($"AH{toRow}").Value = toAdol_Failed;
                wo.Cell($"AI{toRow}").Value = toAdol_LostToFP;
                wo.Cell($"AJ{toRow}").Value = toAdol_NotEval;
                wo.Cell($"AK{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"AK{toRow}").FormulaA1 = $"=IFERROR(IF(AE{toRow}=0,0,AF{toRow}/AE{toRow}),0)";
            }

            // ── Totals, formatting, and sheet setup ───────────────────────
            int cfTotalRow = counter + 1;
            int toTotalRow = counter + 2;

            if (counter > 3)
            {
                string[] cfSumCols = [
                    "G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U",
                    "V","W","X","Y","Z","AA","AB","AC","AD","AE","AF","AG","AH","AI","AJ","AK","AL","AM","AN","AO",
                    "AP","AQ","AR","AS","AT","AU","AV",
                    "AY","AZ","BA","BB",
                    "BC","BD","BE","BF","BG","BH","BI","BJ","BK","BL",
                    "BM","BN","BO","BP","BQ","BR","BS","BT","BU","BV",
                    "BW","BX","BY","BZ","CA","CB",
                    "CE","CF","CG","CH","CI","CJ","CK","CL","CM","CN",
                    "CO","CP","CQ","CR","CS","CT","CU","CV","CW","CX"
                ];
                foreach (var col in cfSumCols)
                    ws.Cell($"{col}{cfTotalRow}").FormulaA1 = $"=SUM({col}4:{col}{counter})";

                ws.Cell($"AW{cfTotalRow}").FormulaA1 = $"=SUM(AW4:AW{counter})";
                ws.Cell($"AX{cfTotalRow}").FormulaA1 =
                    $"=IF(SUM(AR{cfTotalRow}:AV{cfTotalRow})=0,0,AW{cfTotalRow}/SUM(AR{cfTotalRow}:AV{cfTotalRow}))";
                ws.Cell($"AX{cfTotalRow}").Style.NumberFormat.Format = "0.0%";
                ws.Cell($"CC{cfTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(CA{cfTotalRow}=0,0,BW{cfTotalRow}/CA{cfTotalRow}),0)";
                ws.Cell($"CD{cfTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(BX{cfTotalRow}=0,0,BY{cfTotalRow}/BY{cfTotalRow}),0)";
                ws.Range($"CC4:CD{cfTotalRow}").Style.NumberFormat.Format = "0.0%";

                ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Font.Bold = true;
                ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Border.TopBorder    = XLBorderStyleValues.Thin;
                ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Border.BottomBorder = XLBorderStyleValues.Thin;

                string[] toSumCols = [
                    "G","H","I","J","K","L","N","O","P","Q","R","S","T","U","V",
                    "X","Y","Z","AA","AB","AC","AE","AF","AG","AH","AI","AJ"
                ];
                int toDataEnd = counter + 1;
                foreach (var col in toSumCols)
                    wo.Cell($"{col}{toTotalRow}").FormulaA1 = $"=SUM({col}5:{col}{toDataEnd})";

                wo.Cell($"M{toTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(G{toTotalRow}=0,0,H{toTotalRow}/G{toTotalRow}),0)";
                wo.Cell($"W{toTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(Q{toTotalRow}=0,0,R{toTotalRow}/Q{toTotalRow}),0)";
                wo.Cell($"AD{toTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(X{toTotalRow}=0,0,Y{toTotalRow}/X{toTotalRow}),0)";
                wo.Cell($"AK{toTotalRow}").FormulaA1 =
                    $"=IFERROR(IF(AE{toTotalRow}=0,0,AF{toTotalRow}/AE{toTotalRow}),0)";

                wo.Range($"M5:M{toTotalRow}").Style.NumberFormat.Format  = "0.0%";
                wo.Range($"W5:W{toTotalRow}").Style.NumberFormat.Format  = "0.0%";
                wo.Range($"AD5:AD{toTotalRow}").Style.NumberFormat.Format = "0.0%";
                wo.Range($"AK5:AK{toTotalRow}").Style.NumberFormat.Format = "0.0%";

                wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Font.Bold = true;
                wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Border.TopBorder    = XLBorderStyleValues.Thin;
                wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Border.BottomBorder = XLBorderStyleValues.Thin;
            }

            // TO sheet header
            if (periodMonths == 3)
            {
                wo.Cell("F3").Value = $"Q{toOrdinal} of {toYearStr}";
                wo.Cell("G4").Value = $"Cases registered in Q{toOrdinal} of {toYearStr} (New and Relapse)";
            }
            else if (periodMonths == 6)
            {
                string semLbl = toOrdinal == 1 ? "Semester 1" : "Semester 2";
                wo.Cell("F3").Value = $"{semLbl} of {toYearStr}";
                wo.Cell("G4").Value = $"Cases registered in {semLbl} of {toYearStr} (New and Relapse)";
            }
            else
            {
                wo.Cell("F3").Value = $"Year {toYearStr}";
                wo.Cell("G4").Value = $"Cases registered in {toYearStr} (New and Relapse)";
            }

            // CF conditional formatting
            ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0.9, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
            ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0.7, 0.8999).Fill.SetBackgroundColor(XLColor.Yellow);
            ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0, 0.6999).Fill.SetBackgroundColor(XLColor.Red);
            ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
            ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);
            ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0.93, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
            ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0.9, 0.92999).Fill.SetBackgroundColor(XLColor.Yellow);
            ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0, 0.8999).Fill.SetBackgroundColor(XLColor.Red);
            ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
            ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);

            // TO conditional formatting
            foreach (var col in new[] { "M", "W", "AD", "AK" })
            {
                wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0.85, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
                wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0.75, 0.8499).Fill.SetBackgroundColor(XLColor.Yellow);
                wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0, 0.74999).Fill.SetBackgroundColor(XLColor.Red);
                wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
                wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);
            }

            // CF sheet styling
            ws.Range($"E4:CX{cfTotalRow}").Style.Alignment.Vertical   = XLAlignmentVerticalValues.Center;
            ws.Range($"E4:CX{cfTotalRow}").Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            ws.Range($"A1:CX{cfTotalRow}").Style.Font.FontName        = "Segoe UI";
            ws.Range("A1:CX2").Style.Fill.BackgroundColor = XLColor.FromHtml("#00B0F0");
            ws.Range("A3:CX3").Style.Fill.BackgroundColor = XLColor.FromHtml("#FFC000");
            ws.SheetView.FreezeRows(3);
            ws.SheetView.FreezeColumns(6);
            ws.PageSetup.PageOrientation = XLPageOrientation.Landscape;
            ws.PageSetup.PaperSize       = XLPaperSize.A4Paper;
            ws.PageSetup.Footer.Left.AddText(
                $"Exported from the eTBr Server on {DateTime.Now:dddd, dd MMM yyyy HH:mm:ss}");

            ws.Range($"G4:CX{counter}").Style.Protection.SetLocked(false);
            ws.Range($"A1:F{counter}").Style.Protection.SetLocked(true);
            ws.Range($"CC1:CD{counter}").Style.Protection.SetLocked(true);
            ws.Range($"AW4:AX{counter}").Style.Protection.SetLocked(true);
            var cfProt = ws.Protect("0000001");
            cfProt.AllowedElements = XLSheetProtectionElements.InsertRows
                | XLSheetProtectionElements.SelectUnlockedCells
                | XLSheetProtectionElements.InsertColumns;

            // TO sheet styling
            wo.Range($"F5:AK{counter + 1}").Style.Alignment.Vertical   = XLAlignmentVerticalValues.Center;
            wo.Range($"F5:AK{counter + 1}").Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            wo.Range($"A1:AK{toTotalRow}").Style.Font.FontName         = "Segoe UI";
            wo.SheetView.FreezeRows(4);
            wo.SheetView.FreezeColumns(5);
            wo.PageSetup.PageOrientation = XLPageOrientation.Landscape;
            wo.PageSetup.PaperSize       = XLPaperSize.A4Paper;
            wo.PageSetup.AddVerticalPageBreak(29);
            wo.PageSetup.Footer.Left.AddText(
                $"Exported from the eTBr Server on {DateTime.Now:dddd, dd MMM yyyy HH:mm:ss}");

            wo.Range($"F5:K{counter + 1}").Style.Protection.SetLocked(false);
            wo.Range($"M5:U{counter + 1}").Style.Protection.SetLocked(false);
            wo.Range($"W5:AB{counter + 1}").Style.Protection.SetLocked(false);
            var toProt = wo.Protect("0000001");
            toProt.AllowedElements = XLSheetProtectionElements.InsertRows
                | XLSheetProtectionElements.SelectUnlockedCells
                | XLSheetProtectionElements.InsertColumns;

            using var ms = new MemoryStream();
            wb.SaveAs(ms);
            byte[] excelBytes = ms.ToArray();

            // Build filename
            string geoLabel = facilities.Count == 1
                ? facilities[0].FacilityName
                : facilities.Select(f => f.County).Distinct().Count() == 1
                    ? facilities[0].County
                    : "National";
            static char SafeChar(char c) =>
                c is '"' or '\\' or '/' or ':' or '*' or '?' or '<' or '>' or '|' ? '_' : c;
            string safeGeo  = new string(geoLabel.Select(SafeChar).Take(60).ToArray()).Trim();
            string filename = $"{safeGeo}_LFA_Verification_{periodLabel}_{cfYearStr}_SV.xlsx";

            _logger.LogInformation(
                "TB LFA Report completed for {User} — {N} facilities, period {Period} {Year}",
                callerName, facilities.Count, periodLabel, cfYearStr);

            step = totalSteps;
            var token = Guid.NewGuid().ToString("N");
            _cache.Set(token, new ReportCacheEntry(excelBytes, filename),
                new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });
            await Emit(new { done = true, token, filename, step = totalSteps, total = totalSteps });
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in TB LFA SSE report.");
            try { await Emit(new { error = $"Report generation failed: {ex.GetType().Name}: {ex.Message}" }); } catch { }
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/reports/tb-lfa-download?token=<token>
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("tb-lfa-download")]
    public IActionResult TbLfaDownload([FromQuery] string token)
    {
        if (string.IsNullOrEmpty(token) || !Guid.TryParseExact(token, "N", out _))
            return BadRequest(new { error = "Invalid or missing download token." });

        if (!_cache.TryGetValue(token, out ReportCacheEntry? entry) || entry is null)
            return NotFound(new { error = "Download token has expired or was not found. Please regenerate the report." });

        _cache.Remove(token);
        return File(entry.Bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            entry.Filename);
    }

    // Helper alias used throughout the report generator to write a value into
    // a ClosedXML cell while keeping the call sites compact and consistent.
    // Writes a quarter number with its ordinal suffix (e.g. "2" + superscript "nd")
    // into a ClosedXML cell using rich text so the suffix appears as superscript.
    private static void WriteQuarterOrdinal(IXLCell cell, int q)
    {
        string[] suffixes = ["", "st", "nd", "rd", "th"];
        string suffix = (q >= 1 && q <= 4) ? suffixes[q] : q.ToString();
        var rt = cell.GetRichText();
        rt.ClearText();
        rt.AddText(q.ToString());
        rt.AddText(suffix).SetVerticalAlignment(XLFontVerticalTextAlignmentValues.Superscript);
    }

    private static void SW(IXLCell cell, object value)
    {
        if (value == null)
        {
            cell.SetValue(string.Empty);
            return;
        }

        switch (value)
        {
            case int i:
                cell.SetValue(i);
                break;
            case long l:
                cell.SetValue(l);
                break;
            case float f:
                cell.SetValue(f);
                break;
            case double d:
                cell.SetValue(d);
                break;
            case decimal dec:
                cell.SetValue(dec);
                break;
            case string s:
                cell.SetValue(s);
                break;
            default:
                cell.SetValue(value.ToString());
                break;
        }
    }
}
