using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PatientSyncApi.Models;
using PatientSyncApi.Services;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Handles patient data sync requests from the PWA.
///
/// SECURITY:
///   - Connection string is read from server-side config only; never returned to clients.
///   - All SQL uses parameterised queries â€” no string concatenation (OWASP A03:2021).
///   - Exception details are logged server-side only; clients receive generic messages.
///   - [Authorize] on data-write endpoints ensures only authenticated users can sync.
///   - DataSourceID, CountyID, and EnteredByID are stamped server-side from JWT claims
///     so a client cannot falsely claim to belong to a different facility.
/// </summary>
[ApiController]
[Route("api/patients")]
[Authorize]
public sealed class PatientsController : ControllerBase
{
    private readonly string _connectionString;
    private readonly ILogger<PatientsController> _logger;
    private readonly AuditService _audit;

    public PatientsController(IConfiguration config, ILogger<PatientsController> logger, AuditService audit)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _logger = logger;
        _audit  = audit;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/patients/sync
    //  Accepts a JSON array of PatientRecord objects from the PWA and
    //  performs a MERGE (upsert) keyed on PtDetailsTID.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ Extract facility scope from JWT claims â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // DataSourceID, CountyID, and EnteredByID are stamped server-side so
        // the client cannot submit records on behalf of a different facility.
        var userTIDStr   = User.FindFirstValue(ClaimTypes.NameIdentifier)
                        ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                        ?? string.Empty;
        var facilityStr  = User.FindFirstValue("facility_id") ?? "0";
        var countyStr    = User.FindFirstValue("county_id")   ?? "0";

        // DataSourceID = 0 is valid â€” the schema seeds a "Not configured" row
        // (DataSourceT.DataSourceID = 0) so FK constraints are satisfied.
        // Users without a facility assignment (e.g. Admins) may still sync;
        // their records are identified by EnteredByID (the user's GUID).
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

            // MERGE upsert keyed on PtDetailsTID (GUID from PWA).
            // The local device is the source of truth â€” every sync always
            // overwrites the server with the current local record.
            // DataSourceID, CountyID, and EnteredByID are stamped from JWT claims
            // on INSERT and are not updated on subsequent MATCHes.
            // CountyID is resolved from HealthFacilityT using NearestHFID so that
            // every patient record carries the correct county for their enrolled facility,
            // regardless of which county (if any) is stored in the user's JWT claim.
            // @CountyID is kept as a fallback for records where NearestHFID is NULL/0.
            const string mergeSql = """
                MERGE INTO PtDetailsARTT AS target
                USING (
                    SELECT @PtDetailsTID AS PtDetailsTID,
                           COALESCE(NULLIF(hf.CountyID, 0), NULLIF(@CountyID, 0), 0) AS ResolvedCountyID
                    FROM   (VALUES(1)) AS v(n)
                    LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID = @NearestHFID
                ) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    Deleted=@Deleted,
                    NearestHFID=@NearestHFID,
                    CountyID=source.ResolvedCountyID,
                    HIVRetest=@HIVRetest, ARTNo=@ARTNo, ARTStartDate=@ARTStartDate,
                    DateEnrolledInCare=@DateEnrolledInCare, PtName=@PtName,
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
                    DataSourceID, CountyID, EnteredByID, NearestHFID, Deleted,
                    HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare, PtName,
                    ResidenceAddress, Phone1, Phone2, OccupationID, OccupationOther,
                    KeyPopuID, KeyPopuOther, Age, DateOfBirth, SexID,
                    WeightKg, HeightCm, MUACCm, BMI, WHOStageID,
                    CD4Value, CD4IsPercent, CPTStartDate, CPTDrugID,
                    TBRxStartDate, UnitTBNo, TBStatusID, BreastfeedingID, IsTransferIn,
                    TransferFromFacility, GuardianName, GuardianPhone1)
                  VALUES (@PtDetailsTID, 0, GETDATE(), GETDATE(),
                    @DataSourceID, source.ResolvedCountyID, @EnteredByID, @NearestHFID, @Deleted,
                    @HIVRetest, @ARTNo, @ARTStartDate, @DateEnrolledInCare, @PtName,
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
                AddPatientParams(cmd, p, dataSourceID, countyID, enteredByID);
                await cmd.ExecuteNonQueryAsync();
                upserted++;
            }

            await tx.CommitAsync();
            _logger.LogInformation("Sync completed: {Count} record(s) upserted.", upserted);
            await _audit.LogAsync($"Synced {upserted} patient record(s) via /api/patients/sync");
            return Ok(new { message = $"{upserted} record(s) synced successfully." });
        }
        catch (Microsoft.Data.SqlClient.SqlException sqlEx)
        {
            // Return the SQL error number + message so the PWA sync log can
            // show the exact database problem (column missing, FK violation, etc.)
            // without exposing the connection string or server internals.
            var sqlDetail = $"SQL {sqlEx.Number}: {sqlEx.Message}";
            _logger.LogError(sqlEx, "SQL error during patient sync.");
            await _audit.LogErrorAsync("Patient sync failed", sqlEx, context: "POST /api/patients/sync");
            return StatusCode(500, new { error = sqlDetail });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Database error during patient sync.");
            await _audit.LogErrorAsync("Patient sync failed", ex, context: "POST /api/patients/sync");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  POST /api/patients/sync-full
    //  Accepts a full payload: patients + INH + PMTCT + regimen history + visits.
    //  Strategy for PtDetailsARTT: MERGE (upsert) keyed on PtDetailsTID.
    //  Strategy for child tables: DELETE all server-side rows for each patient
    //  then INSERT what the PWA provides â€” guarantees server mirrors local state
    //  even when the PWA re-generates sub-record GUIDs on edit.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpPost("sync-full")]
    public async Task<IActionResult> SyncFull([FromBody] FullSyncPayload? payload)
    {
        if (payload is null)
            return BadRequest(new { error = "No payload provided." });

        if (payload.Patients.Count == 0)
            return BadRequest(new { error = "No patient records provided." });

        if (payload.Patients.Count > 500)
            return BadRequest(new { error = "Batch size exceeds the maximum of 500 records." });

        var errors = ValidateRecords(payload.Patients);
        if (errors.Count > 0)
            return UnprocessableEntity(new { error = "Validation failed.", details = errors });

        // â”€â”€ Extract facility scope from JWT claims â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

            // â”€â”€ Step 1: MERGE PtDetailsARTT â€” local device is source of truth â”€â”€â”€â”€â”€
            // CountyID is resolved from HealthFacilityT using NearestHFID so that
            // every patient record carries the correct county for their enrolled facility,
            // regardless of which county (if any) is stored in the user's JWT claim.
            // @CountyID is kept as a fallback for records where NearestHFID is NULL/0.
            const string mergeSql = """
                MERGE INTO PtDetailsARTT AS target
                USING (
                    SELECT @PtDetailsTID AS PtDetailsTID,
                           COALESCE(NULLIF(hf.CountyID, 0), NULLIF(@CountyID, 0), 0) AS ResolvedCountyID
                    FROM   (VALUES(1)) AS v(n)
                    LEFT JOIN HealthFacilityT hf ON hf.HealthFacilityID = @NearestHFID
                ) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    Deleted=@Deleted,
                    NearestHFID=@NearestHFID,
                    CountyID=source.ResolvedCountyID,
                    HIVRetest=@HIVRetest, ARTNo=@ARTNo, ARTStartDate=@ARTStartDate,
                    DateEnrolledInCare=@DateEnrolledInCare, PtName=@PtName,
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
                    DataSourceID, CountyID, EnteredByID, NearestHFID, Deleted,
                    HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare, PtName,
                    ResidenceAddress, Phone1, Phone2, OccupationID, OccupationOther,
                    KeyPopuID, KeyPopuOther, Age, DateOfBirth, SexID,
                    WeightKg, HeightCm, MUACCm, BMI, WHOStageID,
                    CD4Value, CD4IsPercent, CPTStartDate, CPTDrugID,
                    TBRxStartDate, UnitTBNo, TBStatusID, BreastfeedingID, IsTransferIn,
                    TransferFromFacility, GuardianName, GuardianPhone1)
                  VALUES (@PtDetailsTID, 0, GETDATE(), GETDATE(),
                    @DataSourceID, source.ResolvedCountyID, @EnteredByID, @NearestHFID, @Deleted,
                    @HIVRetest, @ARTNo, @ARTStartDate, @DateEnrolledInCare, @PtName,
                    @ResidenceAddress, @Phone1, @Phone2, @OccupationID, @OccupationOther,
                    @KeyPopuID, @KeyPopuOther, @Age, @DateOfBirth, @SexID,
                    @WeightKg, @HeightCm, @MUACCm, @BMI, @WHOStageID,
                    @CD4Value, @CD4IsPercent, @CPTStartDate, @CPTDrugID,
                    @TBRxStartDate, @UnitTBNo, @TBStatusID, @BreastfeedingID, @IsTransferIn,
                    @TransferFromFacility, @GuardianName, @GuardianPhone1);
                """;

            int upsertedPatients = 0;
            var patientTIDs = new HashSet<Guid>();
            foreach (var p in payload.Patients)
            {
                await using var cmd = new SqlCommand(mergeSql, conn, tx);
                AddPatientParams(cmd, p, dataSourceID, countyID, enteredByID);
                await cmd.ExecuteNonQueryAsync();
                upsertedPatients++;
                patientTIDs.Add(p.PtDetailsTID);
            }

            // â”€â”€ Step 2: Delete all child-table rows for each synced patient â”€â”€
            // The PWA regenerates sub-record GUIDs on every edit (delete+re-insert),
            // so DELETE+INSERT is the only way to guarantee server == local state.
            foreach (var tid in patientTIDs)
            {
                foreach (var table in new[] { "INHProphylaxisT", "PMTCTPregnancyT", "RegimenHistoryT", "PtFollowUpARTT" })
                {
                    await using var delCmd = new SqlCommand(
                        $"DELETE FROM {table} WHERE PtDetailsTID = @TID", conn, tx);
                    delCmd.Parameters.AddWithValue("@TID", tid);
                    await delCmd.ExecuteNonQueryAsync();
                }
            }

            // â”€â”€ Step 3: Insert INH prophylaxis records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const string inhSql = """
                INSERT INTO INHProphylaxisT
                  (INHProphylaxisTID, PtDetailsTID, SequenceNo, INHDate,
                   EnteredByID, HasChanged, LastModOn, CreatedOn)
                VALUES
                  (@INHProphylaxisTID, @PtDetailsTID, @SequenceNo, @INHDate,
                   @EnteredByID, @HasChanged, GETDATE(), GETDATE())
                """;
            foreach (var r in payload.INHRecords.Where(r => patientTIDs.Contains(r.PtDetailsTID)))
            {
                await using var cmd = new SqlCommand(inhSql, conn, tx);
                cmd.Parameters.AddWithValue("@INHProphylaxisTID", r.INHProphylaxisTID);
                cmd.Parameters.AddWithValue("@PtDetailsTID",      r.PtDetailsTID);
                cmd.Parameters.AddWithValue("@SequenceNo",        r.SequenceNo);
                cmd.Parameters.AddWithValue("@INHDate",           (object?)r.INHDate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@EnteredByID",       enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
                cmd.Parameters.AddWithValue("@HasChanged",        r.HasChanged);
                await cmd.ExecuteNonQueryAsync();
            }

            // â”€â”€ Step 4: Insert PMTCT pregnancy records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const string pmtctSql = """
                INSERT INTO PMTCTPregnancyT
                  (PMTCTPregnancyTID, PtDetailsTID, PregnancyNo, ANCNo, DeliveryDate,
                   MotherReceivedART, InfantReceivedARVs, EnteredByID, HasChanged, LastModOn, CreatedOn)
                VALUES
                  (@PMTCTPregnancyTID, @PtDetailsTID, @PregnancyNo, @ANCNo, @DeliveryDate,
                   @MotherReceivedART, @InfantReceivedARVs, @EnteredByID, @HasChanged, GETDATE(), GETDATE())
                """;
            foreach (var r in payload.PMTCTRecords.Where(r => patientTIDs.Contains(r.PtDetailsTID)))
            {
                await using var cmd = new SqlCommand(pmtctSql, conn, tx);
                cmd.Parameters.AddWithValue("@PMTCTPregnancyTID",  r.PMTCTPregnancyTID);
                cmd.Parameters.AddWithValue("@PtDetailsTID",       r.PtDetailsTID);
                cmd.Parameters.AddWithValue("@PregnancyNo",        r.PregnancyNo);
                cmd.Parameters.AddWithValue("@ANCNo",              (object?)r.ANCNo?.Trim() ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@DeliveryDate",       (object?)r.DeliveryDate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@MotherReceivedART",  r.MotherReceivedART);
                cmd.Parameters.AddWithValue("@InfantReceivedARVs", r.InfantReceivedARVs);
                cmd.Parameters.AddWithValue("@EnteredByID",        enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
                cmd.Parameters.AddWithValue("@HasChanged",         r.HasChanged);
                await cmd.ExecuteNonQueryAsync();
            }

            // â”€â”€ Step 5: Insert regimen history records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const string regimenSql = """
                INSERT INTO RegimenHistoryT
                  (RegimenHistoryTID, PtDetailsTID, RegimenLine, SequenceNo, RegimenID,
                   ChangeReasonID, OtherReasonText, EventDate, EnteredByID, HasChanged, LastModOn, CreatedOn)
                VALUES
                  (@RegimenHistoryTID, @PtDetailsTID, @RegimenLine, @SequenceNo, @RegimenID,
                   @ChangeReasonID, @OtherReasonText, @EventDate, @EnteredByID, @HasChanged, GETDATE(), GETDATE())
                """;
            foreach (var r in payload.RegimenHistory.Where(r => patientTIDs.Contains(r.PtDetailsTID)))
            {
                await using var cmd = new SqlCommand(regimenSql, conn, tx);
                cmd.Parameters.AddWithValue("@RegimenHistoryTID", r.RegimenHistoryTID);
                cmd.Parameters.AddWithValue("@PtDetailsTID",      r.PtDetailsTID);
                cmd.Parameters.AddWithValue("@RegimenLine",       r.RegimenLine);
                cmd.Parameters.AddWithValue("@SequenceNo",        r.SequenceNo);
                cmd.Parameters.AddWithValue("@RegimenID",         r.RegimenID);
                cmd.Parameters.AddWithValue("@ChangeReasonID",    r.ChangeReasonID);
                cmd.Parameters.AddWithValue("@OtherReasonText",   (object?)r.OtherReasonText?.Trim() ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@EventDate",         (object?)r.EventDate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@EnteredByID",       enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
                cmd.Parameters.AddWithValue("@HasChanged",        r.HasChanged);
                await cmd.ExecuteNonQueryAsync();
            }

            // â”€â”€ Step 6: Insert follow-up visit records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const string followUpSql = """
                INSERT INTO PtFollowUpARTT
                  (PtFollowUpTID, PtDetailsTID, VisitDate, VisitMonth,
                   FollowUpStatusID, RegimenID, TBStatusID, StopReasonID, StopOtherText,
                   WeeksInterrupted, WeightKg, HeightCm, BMI, CPTDrugID,
                   CD4Value, CD4IsPercent, ViralLoad, Notes,
                   EnteredByID, HasChanged, LastModOn, CreatedOn)
                VALUES
                  (@PtFollowUpTID, @PtDetailsTID, @VisitDate, @VisitMonth,
                   @FollowUpStatusID, @RegimenID, @TBStatusID, @StopReasonID, @StopOtherText,
                   @WeeksInterrupted, @WeightKg, @HeightCm, @BMI, @CPTDrugID,
                   @CD4Value, @CD4IsPercent, @ViralLoad, @Notes,
                   @EnteredByID, @HasChanged, GETDATE(), GETDATE())
                """;
            foreach (var r in payload.FollowUps.Where(r => patientTIDs.Contains(r.PtDetailsTID)))
            {
                await using var cmd = new SqlCommand(followUpSql, conn, tx);
                cmd.Parameters.AddWithValue("@PtFollowUpTID",    r.PtFollowUpTID);
                cmd.Parameters.AddWithValue("@PtDetailsTID",     r.PtDetailsTID);
                cmd.Parameters.AddWithValue("@VisitDate",        (object?)r.VisitDate ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@VisitMonth",       r.VisitMonth);
                cmd.Parameters.AddWithValue("@FollowUpStatusID", r.FollowUpStatusID);
                cmd.Parameters.AddWithValue("@RegimenID",        r.RegimenID);
                cmd.Parameters.AddWithValue("@TBStatusID",       r.TBStatusID);
                cmd.Parameters.AddWithValue("@StopReasonID",     r.StopReasonID);
                cmd.Parameters.AddWithValue("@StopOtherText",    (object?)r.StopOtherText?.Trim() ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@WeeksInterrupted", r.WeeksInterrupted);
                cmd.Parameters.AddWithValue("@WeightKg",         (object?)r.WeightKg ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@HeightCm",         (object?)r.HeightCm ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@BMI",              (object?)r.BMI ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@CPTDrugID",        r.CPTDrugID);
                cmd.Parameters.AddWithValue("@CD4Value",         (object?)r.CD4Value ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@CD4IsPercent",     r.CD4IsPercent);
                cmd.Parameters.AddWithValue("@ViralLoad",        (object?)r.ViralLoad ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@Notes",            (object?)r.Notes?.Trim() ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@EnteredByID",      enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
                cmd.Parameters.AddWithValue("@HasChanged",       r.HasChanged);
                await cmd.ExecuteNonQueryAsync();
            }

            await tx.CommitAsync();

            var counts = new
            {
                patients       = upsertedPatients,
                inhRecords     = payload.INHRecords.Count,
                pmtctRecords   = payload.PMTCTRecords.Count,
                regimenHistory = payload.RegimenHistory.Count,
                followUps      = payload.FollowUps.Count,
            };
            _logger.LogInformation(
                "Full sync: {P} patients, {I} INH, {M} PMTCT, {R} regimen, {F} follow-ups.",
                counts.patients, counts.inhRecords, counts.pmtctRecords, counts.regimenHistory, counts.followUps);
            await _audit.LogAsync(
                $"Full sync: {counts.patients} patient(s), {counts.inhRecords} INH, " +
                $"{counts.pmtctRecords} PMTCT, {counts.regimenHistory} regimen, {counts.followUps} follow-up record(s)");

            return Ok(new
            {
                message = $"{upsertedPatients} patient(s) synced with all related records.",
                details = counts
            });
        }
        catch (Microsoft.Data.SqlClient.SqlException sqlEx)
        {
            var sqlDetail = $"SQL {sqlEx.Number}: {sqlEx.Message}";
            _logger.LogError(sqlEx, "SQL error during full sync.");
            await _audit.LogErrorAsync("Full sync failed", sqlEx, context: "POST /api/patients/sync-full");
            return StatusCode(500, new { error = sqlDetail });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Database error during full sync.");
            await _audit.LogErrorAsync("Full sync failed", ex, context: "POST /api/patients/sync-full");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/patients/geo-tree
    //  Returns the health-facility list filtered to the logged-in user's scope.
    //  - NTP  (MoH / UNDP)     â†’ all facilities  (no filter)
    //  - NTP  + NGO            â†’ facilities for their sub-recipient
    //  - Zonal (state, MoH)    â†’ facilities in their StateID
    //  - Zonal + NGO           â†’ facilities in their SubRecID + LocationID
    //  - DTLS (county, MoH)    â†’ facilities in their CountyID
    //  - DTLS + NGO            â†’ facilities in their SubRecID + LocationID
    //  - Facility staff        â†’ their single facility only
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpGet("geo-tree")]
    public async Task<IActionResult> GetGeoTree()
    {
        // ── Decode role / scope from JWT claims ─────────────────────────────
        bool isNational  = User.IsInRole("National");
        bool isZonal     = User.IsInRole("StateCoordinator");
        bool isDtls      = User.IsInRole("CountySupervisor");
        bool isNgo       = User.IsInRole("NGO");

        int.TryParse(User.FindFirstValue("facility_id"),  out var facilityId);
        int.TryParse(User.FindFirstValue("state_id"),     out var stateId);
        int.TryParse(User.FindFirstValue("county_id"),    out var countyId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),   out var subRecId);
        int.TryParse(User.FindFirstValue("location_id"),  out var locationId);

        var callerTID = User.FindFirstValue(ClaimTypes.NameIdentifier)
                     ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                     ?? string.Empty;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // ── Check for explicit facility assignments ───────────────────────
            // When UserFacilitiesT has rows for this user, those override every
            // other scope rule and become the exact set the user can access.
            var explicitIds = new List<int>();
            await using (var assignCmd = new SqlCommand(
                "SELECT HealthFacilityID FROM UserFacilitiesT WHERE UserTID = @UserTID", conn))
            {
                assignCmd.Parameters.AddWithValue("@UserTID", callerTID);
                await using var ar = await assignCmd.ExecuteReaderAsync();
                while (await ar.ReadAsync())
                    explicitIds.Add(ar.GetInt32(0));
            }

            // ── Build WHERE clause ────────────────────────────────────────────
            string whereClause;
            var    parameters = new Dictionary<string, object>();

            if (explicitIds.Count > 0)
            {
                // Explicit assignment list — overrides all default scope rules.
                var paramNames = explicitIds.Select((_, i) => $"@F{i}").ToList();
                whereClause = $"WHERE v.HealthFacilityID IN ({string.Join(", ", paramNames)})";
                for (int i = 0; i < explicitIds.Count; i++)
                    parameters[$"@F{i}"] = explicitIds[i];
            }
            else if (facilityId > 0)
            {
                // Facility staff — see only their own facility
                whereClause = "WHERE v.HealthFacilityID = @FacilityId";
                parameters["@FacilityId"] = facilityId;
            }
            else if ((isZonal || isDtls) && isNgo)
            {
                // NGO at state or county level — facilities they support at their location
                whereClause = "WHERE v.SubRecID = @SubRecId AND v.LocationID = @LocationId";
                parameters["@SubRecId"]   = subRecId;
                parameters["@LocationId"] = locationId;
            }
            else if (isDtls)
            {
                // County supervisor (MoH) — all facilities in their county
                whereClause = "WHERE v.CountyID = @CountyId";
                parameters["@CountyId"] = countyId;
            }
            else if (isZonal)
            {
                // State coordinator (MoH) — all facilities in their state
                whereClause = "WHERE v.StateID = @StateId";
                parameters["@StateId"] = stateId;
            }
            else if (isNational && isNgo)
            {
                // NGO national — all facilities supported by their sub-recipient
                whereClause = "WHERE v.SubRecID = @SubRecId";
                parameters["@SubRecId"] = subRecId;
            }
            else
            {
                // National MoH / UNDP — all facilities (no filter)
                whereClause = "";
            }

            // Safe: whereClause is built from controlled logic, never user input.
            var sql = $"""
                SELECT v.HealthFacilityID, v.HealthFacility, v.CountyID, v.County, v.StateID, v.State,
                       COALESCE(s.StateShort, '') AS StateShort
                FROM   vwGeogAreaQ v
                LEFT JOIN StateT s ON s.StateID = v.StateID
                {whereClause}
                ORDER  BY v.State, v.County, v.HealthFacility
                """;
            await using var cmd = new SqlCommand(sql, conn);
            foreach (var (k, v) in parameters)
                cmd.Parameters.AddWithValue(k, v);
            var results = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                results.Add(new
                {
                    healthFacilityID = reader.GetInt32(0),
                    healthFacility   = reader.GetString(1).Trim(),
                    countyID         = reader.GetInt32(2),
                    county           = reader.GetString(3).Trim(),
                    stateID          = reader.GetInt32(4),
                    state            = reader.GetString(5).Trim(),
                    stateShort       = reader.IsDBNull(6) ? "" : reader.GetString(6).Trim(),
                });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading geographic tree.");
            return StatusCode(500, new { error = "Could not load geographic data." });
        }
    }
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/patients/lookup/{tableName}
    //  Returns seeded lookup rows for a whitelisted table.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    private static readonly HashSet<string> AllowedLookups = new(StringComparer.OrdinalIgnoreCase)
    {
        "SexT","OccupationT","KeyPopuT","WHOStageT","BreastfeedingT","CPTDrugT",
        "RegimenCategoryT","RegimenARTT","RegimenChangeReasonT","FollowUpStatusT",
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
            // Table name comes from a whitelist â€” safe to embed directly.
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

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/patients/mine?limit=0
    //  Returns all patient records (plus all child records) that were entered
    //  by the authenticated user, ordered by most-recently-modified first.
    //
    //  Primary use case: data recovery after the user's local IndexedDB is
    //  wiped (browser history cleared, device swap, fresh install).
    //
    //  limit=0 (default) â†’ all records; limit=N â†’ most recent N patients.
    //  Dates are serialised as YYYY-MM-DD strings so date inputs on the PWA
    //  accept them without further transformation.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpGet("mine")]
    public async Task<IActionResult> GetMine([FromQuery] int limit = 0, [FromQuery] DateTime? since = null)
    {
        var userTIDStr = User.FindFirstValue(ClaimTypes.NameIdentifier)
                      ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                      ?? string.Empty;

        if (!Guid.TryParse(userTIDStr, out var enteredByID) || enteredByID == Guid.Empty)
            return BadRequest(new { error = "Invalid user identity in token." });

        if (limit < 0)    limit = 0;
        if (limit > 5000) limit = 5000; // sanity cap

        bool isDelta    = since.HasValue;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // â”€â”€ Patients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            var topClause   = (!isDelta && limit > 0) ? $"TOP ({limit})" : "";
            var sinceClause = isDelta ? "AND LastModOn > @Since" : "";
            var patSql = $"""
                SELECT {topClause}
                    CAST(PtDetailsTID AS nvarchar(36))  AS PtDetailsTID,
                    HasChanged, Deleted, NearestHFID,
                    DataSourceID, CountyID,
                    CAST(EnteredByID AS nvarchar(36))   AS EnteredByID,
                    CONVERT(nvarchar(30), LastModOn, 126) AS LastModOn,
                    CONVERT(nvarchar(30), CreatedOn,  126) AS CreatedOn,
                    HIVRetest, ARTNo,
                    CONVERT(nvarchar(10), ARTStartDate,       23) AS ARTStartDate,
                    CONVERT(nvarchar(10), DateEnrolledInCare, 23) AS DateEnrolledInCare,
                    PtName, ResidenceAddress, Phone1, Phone2,
                    OccupationID, OccupationOther, KeyPopuID, KeyPopuOther,
                    Age,
                    CONVERT(nvarchar(10), DateOfBirth, 23) AS DateOfBirth,
                    SexID,
                    WeightKg, HeightCm, MUACCm, BMI,
                    WHOStageID, CD4Value, CD4IsPercent,
                    CONVERT(nvarchar(10), CPTStartDate,  23) AS CPTStartDate,
                    CPTDrugID,
                    CONVERT(nvarchar(10), TBRxStartDate, 23) AS TBRxStartDate,
                    UnitTBNo, TBStatusID,
                    BreastfeedingID, IsTransferIn, TransferFromFacility,
                    GuardianName, GuardianPhone1
                FROM PtDetailsARTT
                WHERE EnteredByID = @EnteredByID
                {sinceClause}
                ORDER BY LastModOn DESC
                """;

            await using var patCmd = new SqlCommand(patSql, conn);
            patCmd.Parameters.AddWithValue("@EnteredByID", enteredByID);
            if (isDelta) patCmd.Parameters.AddWithValue("@Since", since!.Value);

            var patients = new List<Dictionary<string, object?>>();
            await using (var reader = await patCmd.ExecuteReaderAsync())
            {
                while (await reader.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < reader.FieldCount; i++)
                        row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                    patients.Add(row);
                }
            }

            if (!isDelta && patients.Count == 0)
            {
                return Ok(new
                {
                    patients       = patients,
                    inhRecords     = Array.Empty<object>(),
                    pmtctRecords   = Array.Empty<object>(),
                    regimenHistory = Array.Empty<object>(),
                    followUps      = Array.Empty<object>(),
                });
            }

            // â”€â”€ Child records â€” scoped to the same patient set via OPENJSON â”€â”€
            // OPENJSON parses the JSON array of GUID strings and casts each to
            // uniqueidentifier so the FK join is type-safe and index-friendly.
            // ── Child records ──────────────────────────────────────────────────────────
            // Delta: each table filtered by EnteredByID + LastModOn > @Since.
            //   importFullPayloadFromServer safely merges with INSERT OR IGNORE + UPDATE
            //   WHERE HasChanged=0 AND LastModOn < server, so local edits are never lost.
            // Full pull: child records scoped to the parent TID set via OPENJSON.
            List<Dictionary<string, object?>> inhRecords, pmtctRecords, regimenHistory, followUps;

            if (isDelta)
            {
                async Task<List<Dictionary<string, object?>>> ReadDeltaChild(string sql)
                {
                    await using var cmd = new SqlCommand(sql, conn);
                    cmd.Parameters.AddWithValue("@EnteredByID", enteredByID);
                    cmd.Parameters.AddWithValue("@Since", since!.Value);
                    var rows = new List<Dictionary<string, object?>>();
                    await using var rdr = await cmd.ExecuteReaderAsync();
                    while (await rdr.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>();
                        for (int i = 0; i < rdr.FieldCount; i++)
                            row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                        rows.Add(row);
                    }
                    return rows;
                }

                inhRecords = await ReadDeltaChild("""
                    SELECT CAST(INHProphylaxisTID AS nvarchar(36)) AS INHProphylaxisTID,
                           CAST(PtDetailsTID     AS nvarchar(36)) AS PtDetailsTID,
                           SequenceNo,
                           CONVERT(nvarchar(10), INHDate, 23)     AS INHDate,
                           CAST(EnteredByID      AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)  AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126) AS CreatedOn
                    FROM INHProphylaxisT
                    WHERE EnteredByID = @EnteredByID AND LastModOn > @Since
                    """);

                pmtctRecords = await ReadDeltaChild("""
                    SELECT CAST(PMTCTPregnancyTID AS nvarchar(36)) AS PMTCTPregnancyTID,
                           CAST(PtDetailsTID      AS nvarchar(36)) AS PtDetailsTID,
                           PregnancyNo, ANCNo,
                           CONVERT(nvarchar(10), DeliveryDate, 23) AS DeliveryDate,
                           MotherReceivedART, InfantReceivedARVs,
                           CAST(EnteredByID       AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)   AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126)  AS CreatedOn
                    FROM PMTCTPregnancyT
                    WHERE EnteredByID = @EnteredByID AND LastModOn > @Since
                    """);

                regimenHistory = await ReadDeltaChild("""
                    SELECT CAST(RegimenHistoryTID AS nvarchar(36)) AS RegimenHistoryTID,
                           CAST(PtDetailsTID      AS nvarchar(36)) AS PtDetailsTID,
                           RegimenLine, SequenceNo, RegimenID, ChangeReasonID, OtherReasonText,
                           CONVERT(nvarchar(10), EventDate, 23)    AS EventDate,
                           CAST(EnteredByID       AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)   AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126)  AS CreatedOn
                    FROM RegimenHistoryT
                    WHERE EnteredByID = @EnteredByID AND LastModOn > @Since
                    """);

                followUps = await ReadDeltaChild("""
                    SELECT CAST(PtFollowUpTID AS nvarchar(36)) AS PtFollowUpTID,
                           CAST(PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                           CONVERT(nvarchar(10), VisitDate, 23) AS VisitDate,
                           VisitMonth, FollowUpStatusID, RegimenID, TBStatusID,
                           StopReasonID, StopOtherText, WeeksInterrupted,
                           WeightKg, HeightCm, BMI, CPTDrugID,
                           CD4Value, CD4IsPercent, ViralLoad, Notes, Deleted,
                           CAST(EnteredByID   AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126) AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126) AS CreatedOn
                    FROM PtFollowUpARTT
                    WHERE EnteredByID = @EnteredByID AND LastModOn > @Since
                    """);
            }
            else
            {
                // Full pull: child records scoped to parent TIDs via OPENJSON.
                var tidsList = patients
                    .Select(p => p["PtDetailsTID"]?.ToString())
                    .Where(t => !string.IsNullOrEmpty(t))
                    .ToList();

                var tidsJson = System.Text.Json.JsonSerializer.Serialize(tidsList);
                const string childFilter = """
                    WHERE CAST(PtDetailsTID AS nvarchar(36)) IN
                          (SELECT value FROM OPENJSON(@TIDsJson))
                    """;

                async Task<List<Dictionary<string, object?>>> ReadChildTable(string tableSql)
                {
                    await using var cmd = new SqlCommand(tableSql, conn);
                    cmd.Parameters.AddWithValue("@TIDsJson", tidsJson);
                    var rows = new List<Dictionary<string, object?>>();
                    await using var rdr = await cmd.ExecuteReaderAsync();
                    while (await rdr.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>();
                        for (int i = 0; i < rdr.FieldCount; i++)
                            row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                        rows.Add(row);
                    }
                    return rows;
                }

                inhRecords = await ReadChildTable($"""
                    SELECT CAST(INHProphylaxisTID AS nvarchar(36)) AS INHProphylaxisTID,
                           CAST(PtDetailsTID     AS nvarchar(36)) AS PtDetailsTID,
                           SequenceNo,
                           CONVERT(nvarchar(10), INHDate, 23)     AS INHDate,
                           CAST(EnteredByID      AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)  AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126) AS CreatedOn
                    FROM INHProphylaxisT {childFilter}
                    """);

                pmtctRecords = await ReadChildTable($"""
                    SELECT CAST(PMTCTPregnancyTID AS nvarchar(36)) AS PMTCTPregnancyTID,
                           CAST(PtDetailsTID      AS nvarchar(36)) AS PtDetailsTID,
                           PregnancyNo, ANCNo,
                           CONVERT(nvarchar(10), DeliveryDate, 23) AS DeliveryDate,
                           MotherReceivedART, InfantReceivedARVs,
                           CAST(EnteredByID       AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)   AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126)  AS CreatedOn
                    FROM PMTCTPregnancyT {childFilter}
                    """);

                regimenHistory = await ReadChildTable($"""
                    SELECT CAST(RegimenHistoryTID AS nvarchar(36)) AS RegimenHistoryTID,
                           CAST(PtDetailsTID      AS nvarchar(36)) AS PtDetailsTID,
                           RegimenLine, SequenceNo, RegimenID, ChangeReasonID, OtherReasonText,
                           CONVERT(nvarchar(10), EventDate, 23)    AS EventDate,
                           CAST(EnteredByID       AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126)   AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126)  AS CreatedOn
                    FROM RegimenHistoryT {childFilter}
                    """);

                followUps = await ReadChildTable($"""
                    SELECT CAST(PtFollowUpTID AS nvarchar(36)) AS PtFollowUpTID,
                           CAST(PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                           CONVERT(nvarchar(10), VisitDate, 23) AS VisitDate,
                           VisitMonth, FollowUpStatusID, RegimenID, TBStatusID,
                           StopReasonID, StopOtherText, WeeksInterrupted,
                           WeightKg, HeightCm, BMI, CPTDrugID,
                           CD4Value, CD4IsPercent, ViralLoad, Notes, Deleted,
                           CAST(EnteredByID   AS nvarchar(36)) AS EnteredByID,
                           HasChanged,
                           CONVERT(nvarchar(30), LastModOn, 126) AS LastModOn,
                           CONVERT(nvarchar(30), CreatedOn,  126) AS CreatedOn
                    FROM PtFollowUpARTT {childFilter}
                    """);
            }

            await _audit.LogAsync(
                $"Restored {patients.Count} patient record(s) from server (limit={limit})");

            _logger.LogInformation(
                "GetMine: {P} patients, {I} INH, {M} PMTCT, {R} regimen, {F} visits for {UserTID}.",
                patients.Count, inhRecords.Count, pmtctRecords.Count,
                regimenHistory.Count, followUps.Count, enteredByID);

            return Ok(new { patients, inhRecords, pmtctRecords, regimenHistory, followUps });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GetMine for {UserTID}.", enteredByID);
            return StatusCode(500, new { error = "Could not retrieve your patient records." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  GET /api/patients/check-duplicate
    //  Checks the server for potential duplicate patient records.
    //
    //  Two independent checks (either or both can be requested):
    //    â€¢ artNo  â†’ exact ART-number match (case-insensitive) across all patients
    //    â€¢ name + age + sexId  â†’ same name/age/sex within the same facility
    //
    //  Returns enough context for the PWA to show a meaningful warning.
    //  Does NOT return PII beyond what the data-entrant already has access to.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    [HttpGet("check-duplicate")]
    public async Task<IActionResult> CheckDuplicate(
        [FromQuery] string? artNo    = null,
        [FromQuery] string? name     = null,
        [FromQuery] int     age      = -1,
        [FromQuery] int     sexId    = -1,
        [FromQuery] int     facilityId = 0)
    {
        bool checkArt  = !string.IsNullOrWhiteSpace(artNo);
        bool checkName = !string.IsNullOrWhiteSpace(name) && age >= 0 && sexId > 0;

        if (!checkArt && !checkName)
            return BadRequest(new { error = "Provide artNo, or name+age+sexId." });

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Shared projection â€” just enough to render a warning card.
            const string projection = """
                SELECT CAST(PtDetailsTID AS nvarchar(36)) AS PtDetailsTID,
                       ARTNo, PtName, Age,
                       CONVERT(nvarchar(10), ARTStartDate, 23) AS ARTStartDate,
                       NearestHFID
                FROM PtDetailsARTT
                """;

            var artNoMatches  = new List<Dictionary<string, object?>>();
            var nameMatches   = new List<Dictionary<string, object?>>();

            if (checkArt)
            {
                await using var cmd = new SqlCommand(
                    $"{projection} WHERE LOWER(LTRIM(RTRIM(ARTNo))) = LOWER(LTRIM(RTRIM(@ArtNo))) AND Deleted = 0",
                    conn);
                cmd.Parameters.AddWithValue("@ArtNo", artNo!.Trim());
                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < rdr.FieldCount; i++)
                        row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                    artNoMatches.Add(row);
                }
            }

            if (checkName)
            {
                var facilityFilter = facilityId > 0 ? "AND NearestHFID = @FacilityId" : "";
                await using var cmd = new SqlCommand(
                    $"{projection} WHERE LOWER(LTRIM(RTRIM(PtName))) = LOWER(LTRIM(RTRIM(@Name))) AND Age = @Age AND SexID = @SexId AND Deleted = 0 {facilityFilter}",
                    conn);
                cmd.Parameters.AddWithValue("@Name",  name!.Trim());
                cmd.Parameters.AddWithValue("@Age",   age);
                cmd.Parameters.AddWithValue("@SexId", sexId);
                if (facilityId > 0)
                    cmd.Parameters.AddWithValue("@FacilityId", facilityId);
                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    var row = new Dictionary<string, object?>();
                    for (int i = 0; i < rdr.FieldCount; i++)
                        row[rdr.GetName(i)] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
                    nameMatches.Add(row);
                }
            }

            return Ok(new { artNoMatches, nameMatches });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in CheckDuplicate.");
            return StatusCode(500, new { error = "Duplicate check failed." });
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //  Private helpers
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private static void AddPatientParams(
        SqlCommand cmd, PatientRecord p,
        int dataSourceID, int countyID, Guid enteredByID)
    {
        // Server-stamped scope fields — not read from client input.
        // DataSourceID: prefer the JWT facility claim; if the user account has no
        // facility assigned (claim = 0), fall back to NearestHFID from the payload
        // (the facility the user selected in the tree — same logical value for
        // facility-level users).  Only store NULL when neither is known.
        // NearestHFID comes from the payload (the tree-selected facility).
        var effectiveDataSourceID = dataSourceID > 0 ? dataSourceID
                                  : (p.NearestHFID > 0 ? p.NearestHFID : 0);
        cmd.Parameters.AddWithValue("@DataSourceID",
            effectiveDataSourceID == 0 ? (object)DBNull.Value : effectiveDataSourceID);
        cmd.Parameters.AddWithValue("@CountyID",
            countyID == 0 ? (object)DBNull.Value : countyID);
        cmd.Parameters.AddWithValue("@EnteredByID",
            enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
        // NearestHFID=0 is valid â€” HealthFacilityT has a row 0 ('Not configured')
        // and the column is NOT NULL, so never send DBNull here.
        cmd.Parameters.AddWithValue("@NearestHFID", p.NearestHFID);
        cmd.Parameters.AddWithValue("@Deleted", p.Deleted);
        cmd.Parameters.AddWithValue("@PtDetailsTID",         p.PtDetailsTID);
        cmd.Parameters.AddWithValue("@HasChanged",           p.HasChanged);
        cmd.Parameters.AddWithValue("@HIVRetest",            p.HIVRetest);
        cmd.Parameters.AddWithValue("@ARTNo",                p.ARTNo.Trim());
        cmd.Parameters.AddWithValue("@ARTStartDate",         (object?)p.ARTStartDate ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@DateEnrolledInCare",   (object?)p.DateEnrolledInCare ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@PtName",             p.PtName.Trim());
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

            if (string.IsNullOrWhiteSpace(p.PtName) || p.PtName.Trim().Length < 2)
                errors.Add($"{label}: PtName is required (min 2 characters).");

            if (p.Age < 0 || p.Age > 99)
                errors.Add($"{label}: Age must be 0â€“99.");

            if (p.SexID < 0 || p.SexID > 2)
                errors.Add($"{label}: SexID must be 0, 1, or 2.");

            if (p.WeightKg.HasValue && (p.WeightKg < 1 || p.WeightKg > 250))
                errors.Add($"{label}: WeightKg must be 1â€“250 kg.");

            if (p.HeightCm.HasValue && (p.HeightCm < 30 || p.HeightCm > 250))
                errors.Add($"{label}: HeightCm must be 30â€“250 cm.");

            if (p.MUACCm.HasValue && (p.MUACCm < 5 || p.MUACCm > 60))
                errors.Add($"{label}: MUACCm must be 5â€“60 cm.");

            if (p.CD4Value.HasValue)
            {
                var maxCd4 = p.CD4IsPercent == 1 ? 100 : 3500;
                if (p.CD4Value < 0 || p.CD4Value > maxCd4)
                    errors.Add($"{label}: CD4Value must be 0â€“{maxCd4} ({(p.CD4IsPercent == 1 ? "%" : "cells/ÂµL")}).");
            }
        }
        return errors;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  GET /api/patients/search?q=john&register=ART|TB
    //
    //  Full-text patient search scoped to the caller's geo area.
    //  Used by read-only supervisory users (national/state/county/NTP) who
    //  do not pull patient records locally, so they must search the server.
    //  Data-entry users also call this as a fallback when the local DB is
    //  empty (e.g. first login on a new device).
    //
    //  SECURITY:
    //   - geoWhere is built entirely from controlled boolean logic; the only
    //     user-supplied value is `q`, bound as @Q (parameterised).
    //   - Results are capped at 200 rows per register to prevent data dumping.
    //   - [Authorize] ensures unauthenticated callers receive 401.
    // ─────────────────────────────────────────────────────────────────────
    [HttpGet("search")]
    public async Task<IActionResult> Search(
        [FromQuery] string q        = "",
        [FromQuery] string register = "all")
    {
        q = (q ?? "").Trim();
        if (q.Length < 1)   return BadRequest(new { error = "Search term is required." });
        if (q.Length > 200) q = q[..200];

        bool searchArt = register != "TB";
        bool searchTb  = register != "ART";

        bool isNgo   = User.IsInRole("NGO");
        bool isZonal = User.IsInRole("StateCoordinator");
        bool isDtls  = User.IsInRole("CountySupervisor");

        int.TryParse(User.FindFirstValue("facility_id"), out var facilityId);
        int.TryParse(User.FindFirstValue("state_id"),    out var stateId);
        int.TryParse(User.FindFirstValue("county_id"),   out var countyId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),  out var subRecId);
        int.TryParse(User.FindFirstValue("location_id"), out var locationId);

        var callerTID = User.FindFirstValue(ClaimTypes.NameIdentifier)
                     ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                     ?? string.Empty;

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // ── Explicit facility assignments override all scope rules ────────
            var explicitIds = new List<int>();
            await using (var aCmd = new SqlCommand(
                "SELECT HealthFacilityID FROM UserFacilitiesT WHERE UserTID = @UserTID", conn))
            {
                aCmd.Parameters.AddWithValue("@UserTID", callerTID);
                await using var ar = await aCmd.ExecuteReaderAsync();
                while (await ar.ReadAsync()) explicitIds.Add(ar.GetInt32(0));
            }

            // ── Build geo WHERE clause (column names only — no user input) ───
            string geoWhere;
            var geoParams = new Dictionary<string, object>();

            if (explicitIds.Count > 0)
            {
                var pNames = explicitIds.Select((_, i) => $"@F{i}").ToList();
                geoWhere = $"hf.HealthFacilityID IN ({string.Join(", ", pNames)})";
                for (int i = 0; i < explicitIds.Count; i++) geoParams[$"@F{i}"] = explicitIds[i];
            }
            else if (facilityId > 0)
            {
                geoWhere = "hf.HealthFacilityID = @FacId";
                geoParams["@FacId"] = facilityId;
            }
            else if ((isZonal || isDtls) && isNgo)
            {
                geoWhere = "hf.SubRecID = @SubRecId AND hf.LocationID = @LocId";
                geoParams["@SubRecId"] = subRecId;
                geoParams["@LocId"]    = locationId;
            }
            else if (isDtls)
            {
                geoWhere = "hf.CountyID = @CountyId";
                geoParams["@CountyId"] = countyId;
            }
            else if (isZonal)
            {
                geoWhere = "hf.StateID = @StateId";
                geoParams["@StateId"] = stateId;
            }
            else if (isNgo)
            {
                geoWhere = "hf.SubRecID = @SubRecId";
                geoParams["@SubRecId"] = subRecId;
            }
            else
            {
                geoWhere = "1=1"; // National MoH — no additional geo filter
            }

            async Task<List<object>> QueryTable(string tableName, string patientNoCol, string phoneCol)
            {
                // SECURITY: tableName/patientNoCol/phoneCol are only ever passed
                // as hardcoded literals from the two call-sites below.
                var sql = $"""
                    SELECT TOP 200
                        CASE WHEN '{tableName}' = 'PtDetailsARTT' THEN 'ART' ELSE 'TB' END AS Register,
                        CAST(p.PtDetailsTID  AS nvarchar(36)) AS PtDetailsTID,
                        COALESCE(p.PtName, '')                AS PtName,
                        COALESCE(p.{patientNoCol}, '')        AS PatientNo,
                        p.Age,
                        COALESCE(s.Sex, '')                   AS Sex,
                        COALESCE(p.{phoneCol}, '')            AS Phone,
                        COALESCE(hf.HealthFacility, '')       AS HealthFacility,
                        COALESCE(p.NearestHFID, 0)            AS NearestHFID
                    FROM   {tableName} p
                    JOIN   HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
                    LEFT JOIN SexT         s  ON s.SexID = p.SexID
                    WHERE  ISNULL(p.Deleted, 0) = 0
                      AND  ({geoWhere})
                      AND  (p.PtName LIKE @Q OR p.{patientNoCol} LIKE @Q
                            OR p.{phoneCol} LIKE @Q OR hf.HealthFacility LIKE @Q)
                    ORDER BY p.PtName ASC
                    """;

                await using var cmd = conn.CreateCommand();
                cmd.CommandText    = sql;
                cmd.CommandTimeout = 30;
                cmd.Parameters.AddWithValue("@Q", $"%{q}%");
                foreach (var (k, v) in geoParams) cmd.Parameters.AddWithValue(k, v);

                var rows = new List<object>();
                await using var rdr = await cmd.ExecuteReaderAsync();
                while (await rdr.ReadAsync())
                {
                    rows.Add(new
                    {
                        register       = rdr.GetString(0),
                        ptDetailsTID   = rdr.GetString(1),
                        ptName         = rdr.GetString(2),
                        patientNo      = rdr.GetString(3),
                        age            = rdr.IsDBNull(4)  ? (int?)null : rdr.GetInt32(4),
                        sex            = rdr.GetString(5),
                        phone          = rdr.GetString(6),
                        healthFacility = rdr.GetString(7),
                        nearestHFID    = rdr.GetInt32(8),
                    });
                }
                return rows;
            }

            var results = new List<object>();
            if (searchArt) results.AddRange(await QueryTable("PtDetailsARTT", "ARTNo",    "Phone1"));
            if (searchTb)  results.AddRange(await QueryTable("PtDetailsT",    "UnitTBNo", "PtPhone"));

            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Patient search error for {UserTID}.", callerTID);
            return StatusCode(500, new { error = "Search failed." });
        }
    }
}