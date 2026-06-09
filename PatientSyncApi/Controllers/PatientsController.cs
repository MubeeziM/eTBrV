using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Handles patient data sync requests from the PWA.
///
/// SECURITY:
///   - Connection string is read from server-side config only; never returned to clients.
///   - All SQL uses parameterised queries — no string concatenation (OWASP A03:2021).
///   - Exception details are logged server-side only; clients receive generic messages.
/// </summary>
[ApiController]
[Route("api/patients")]
public sealed class PatientsController : ControllerBase
{
    private readonly string _connectionString;
    private readonly ILogger<PatientsController> _logger;

    public PatientsController(IConfiguration config, ILogger<PatientsController> logger)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  POST /api/patients/sync
    //  Accepts a JSON array of PatientRecord objects from the PWA and
    //  performs a MERGE (upsert) keyed on PtDetailsTID.
    // ──────────────────────────────────────────────────────────────────────
    [HttpPost("sync")]
    public async Task<IActionResult> Sync([FromBody] List<PatientRecord>? patients)
    {
        if (patients is null || patients.Count == 0)
            return BadRequest(new { error = "No patient records provided." });

        if (patients.Count > 500)
            return BadRequest(new { error = "Batch size exceeds the maximum of 500 records." });

        var errors = ValidateRecords(patients);
        if (errors.Count > 0)
            return UnprocessableEntity(new { error = "Validation failed.", details = errors });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync();

            // MERGE upsert keyed on PtDetailsTID (GUID from PWA)
            const string mergeSql = """
                MERGE INTO PtDetailsT AS target
                USING (SELECT @PtDetailsTID AS PtDetailsTID) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED AND target.HasChanged = 0 THEN
                  UPDATE SET
                    HasChanged=@HasChanged, LastModOn=GETDATE(),
                    HIVRetest=@HIVRetest, ARTNo=@ARTNo, ARTStartDate=@ARTStartDate,
                    DateEnrolledInCare=@DateEnrolledInCare, FullName=@FullName,
                    ResidenceAddress=@ResidenceAddress, Phone1=@Phone1, Phone2=@Phone2,
                    OccupationID=@OccupationID, OccupationOther=@OccupationOther,
                    KeyPopuID=@KeyPopuID, KeyPopuOther=@KeyPopuOther,
                    Age=@Age, DateOfBirth=@DateOfBirth, SexID=@SexID,
                    WeightKg=@WeightKg, HeightCm=@HeightCm, MUACCm=@MUACCm, BMI=@BMI,
                    WHOStageID=@WHOStageID, CD4Value=@CD4Value, CD4IsPercent=@CD4IsPercent,
                    CPTStartDate=@CPTStartDate, CPTDrugID=@CPTDrugID,
                    TBRxStartDate=@TBRxStartDate, UnitTBNo=@UnitTBNo, TBStatusID=@TBStatusID,
                    BreastfeedingID=@BreastfeedingID, IsTransferIn=@IsTransferIn,
                    TransferFromFacility=@TransferFromFacility,
                    GuardianName=@GuardianName, GuardianPhone1=@GuardianPhone1
                WHEN NOT MATCHED THEN
                  INSERT (PtDetailsTID, HasChanged, LastModOn, CreatedOn,
                    HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare, FullName,
                    ResidenceAddress, Phone1, Phone2, OccupationID, OccupationOther,
                    KeyPopuID, KeyPopuOther, Age, DateOfBirth, SexID,
                    WeightKg, HeightCm, MUACCm, BMI, WHOStageID,
                    CD4Value, CD4IsPercent, CPTStartDate, CPTDrugID,
                    TBRxStartDate, UnitTBNo, TBStatusID, BreastfeedingID, IsTransferIn,
                    TransferFromFacility, GuardianName, GuardianPhone1)
                  VALUES (@PtDetailsTID, @HasChanged, GETDATE(), GETDATE(),
                    @HIVRetest, @ARTNo, @ARTStartDate, @DateEnrolledInCare, @FullName,
                    @ResidenceAddress, @Phone1, @Phone2, @OccupationID, @OccupationOther,
                    @KeyPopuID, @KeyPopuOther, @Age, @DateOfBirth, @SexID,
                    @WeightKg, @HeightCm, @MUACCm, @BMI, @WHOStageID,
                    @CD4Value, @CD4IsPercent, @CPTStartDate, @CPTDrugID,
                    @TBRxStartDate, @UnitTBNo, @TBStatusID, @BreastfeedingID, @IsTransferIn,
                    @TransferFromFacility, @GuardianName, @GuardianPhone1);
                """;

            int upserted = 0;
            foreach (var p in patients)
            {
                await using var cmd = new SqlCommand(mergeSql, conn, tx);
                AddPatientParams(cmd, p);
                await cmd.ExecuteNonQueryAsync();
                upserted++;
            }

            await tx.CommitAsync();
            _logger.LogInformation("Sync completed: {Count} record(s) upserted.", upserted);
            return Ok(new { message = $"{upserted} record(s) synced successfully." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Database error during patient sync.");
            return StatusCode(500, new { error = "An error occurred while syncing. Please try again later." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/patients/lookup/{tableName}
    //  Returns seeded lookup rows for a whitelisted table.
    // ──────────────────────────────────────────────────────────────────────
    private static readonly HashSet<string> AllowedLookups = new(StringComparer.OrdinalIgnoreCase)
    {
        "SexT","OccupationT","KeyPopuT","WHOStageT","BreastfeedingT","CPTDrugT",
        "RegimenCategoryT","RegimenT","RegimenChangeReasonT","FollowUpStatusT",
        "TBStatusT","StopReasonT","CountyT","HealthFacilityT","DataSourceT"
    };

    [HttpGet("lookup/{tableName}")]
    public async Task<IActionResult> GetLookup(string tableName)
    {
        if (!AllowedLookups.Contains(tableName))
            return NotFound(new { error = "Unknown lookup table." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            // Table name comes from a whitelist — safe to embed directly.
            await using var cmd = new SqlCommand($"SELECT * FROM {tableName} ORDER BY 1", conn);
            await using var reader = await cmd.ExecuteReaderAsync();
            var rows = new List<Dictionary<string, object?>>();
            while (await reader.ReadAsync())
            {
                var row = new Dictionary<string, object?>();
                for (int i = 0; i < reader.FieldCount; i++)
                    row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                rows.Add(row);
            }
            return Ok(rows);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching lookup table {Table}.", tableName);
            return StatusCode(500, new { error = "Could not fetch lookup data." });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Private helpers
    // ──────────────────────────────────────────────────────────────────────

    private static void AddPatientParams(SqlCommand cmd, PatientRecord p)
    {
        cmd.Parameters.AddWithValue("@PtDetailsTID",         p.PtDetailsTID);
        cmd.Parameters.AddWithValue("@HasChanged",           p.HasChanged);
        cmd.Parameters.AddWithValue("@HIVRetest",            p.HIVRetest);
        cmd.Parameters.AddWithValue("@ARTNo",                p.ARTNo.Trim());
        cmd.Parameters.AddWithValue("@ARTStartDate",         (object?)p.ARTStartDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@DateEnrolledInCare",   (object?)p.DateEnrolledInCare ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@FullName",             p.FullName.Trim());
        cmd.Parameters.AddWithValue("@ResidenceAddress",     (object?)p.ResidenceAddress?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Phone1",               (object?)p.Phone1?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Phone2",               (object?)p.Phone2?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@OccupationID",         p.OccupationID);
        cmd.Parameters.AddWithValue("@OccupationOther",      (object?)p.OccupationOther?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@KeyPopuID",            p.KeyPopuID);
        cmd.Parameters.AddWithValue("@KeyPopuOther",         (object?)p.KeyPopuOther?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@Age",                  p.Age);
        cmd.Parameters.AddWithValue("@DateOfBirth",          (object?)p.DateOfBirth ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@SexID",                p.SexID);
        cmd.Parameters.AddWithValue("@WeightKg",             (object?)p.WeightKg ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@HeightCm",             (object?)p.HeightCm ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@MUACCm",               (object?)p.MUACCm ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@BMI",                  (object?)p.BMI ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@WHOStageID",           p.WHOStageID);
        cmd.Parameters.AddWithValue("@CD4Value",             (object?)p.CD4Value ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@CD4IsPercent",         p.CD4IsPercent);
        cmd.Parameters.AddWithValue("@CPTStartDate",         (object?)p.CPTStartDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@CPTDrugID",            p.CPTDrugID);
        cmd.Parameters.AddWithValue("@TBRxStartDate",        (object?)p.TBRxStartDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@UnitTBNo",             (object?)p.UnitTBNo?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@TBStatusID",           p.TBStatusID);
        cmd.Parameters.AddWithValue("@BreastfeedingID",      p.BreastfeedingID);
        cmd.Parameters.AddWithValue("@IsTransferIn",         p.IsTransferIn);
        cmd.Parameters.AddWithValue("@TransferFromFacility", (object?)p.TransferFromFacility?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@GuardianName",         (object?)p.GuardianName?.Trim() ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@GuardianPhone1",       (object?)p.GuardianPhone1?.Trim() ?? DBNull.Value);
    }

    private static List<string> ValidateRecords(List<PatientRecord> patients)
    {
        var errors = new List<string>();
        for (int i = 0; i < patients.Count; i++)
        {
            var p     = patients[i];
            var label = $"Record {i + 1}";

            if (p.PtDetailsTID == Guid.Empty)
                errors.Add($"{label}: PtDetailsTID is required.");

            if (string.IsNullOrWhiteSpace(p.ARTNo))
                errors.Add($"{label}: ARTNo is required.");

            if (string.IsNullOrWhiteSpace(p.FullName) || p.FullName.Trim().Length < 2)
                errors.Add($"{label}: FullName is required (min 2 characters).");

            if (p.Age < 0 || p.Age > 99)
                errors.Add($"{label}: Age must be 0–99.");

            if (p.SexID < 0 || p.SexID > 2)
                errors.Add($"{label}: SexID must be 0, 1, or 2.");
        }
        return errors;
    }
}
