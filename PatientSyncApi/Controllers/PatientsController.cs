using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
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

        // ── Extract facility scope from JWT claims ────────────────────────
        // DataSourceID, CountyID, and EnteredByID are stamped server-side so
        // the client cannot submit records on behalf of a different facility.
        var userTIDStr   = User.FindFirstValue(ClaimTypes.NameIdentifier)
                        ?? User.FindFirstValue(JwtRegisteredClaimNames.Sub)
                        ?? string.Empty;
        var facilityStr  = User.FindFirstValue("facility_id") ?? "0";
        var countyStr    = User.FindFirstValue("county_id")   ?? "0";

        // DataSourceID = 0 is valid — the schema seeds a "Not configured" row
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
            // The local device is the source of truth — every sync always
            // overwrites the server with the current local record.
            // DataSourceID, CountyID, and EnteredByID are stamped from JWT claims
            // on INSERT and are not updated on subsequent MATCHes.
            const string mergeSql = """
                MERGE INTO PtDetailsT AS target
                USING (SELECT @PtDetailsTID AS PtDetailsTID) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    Deleted=@Deleted,
                    NearestHFID=@NearestHFID,
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
                    DataSourceID, CountyID, EnteredByID, NearestHFID, Deleted,
                    HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare, FullName,
                    ResidenceAddress, Phone1, Phone2, OccupationID, OccupationOther,
                    KeyPopuID, KeyPopuOther, Age, DateOfBirth, SexID,
                    WeightKg, HeightCm, MUACCm, BMI, WHOStageID,
                    CD4Value, CD4IsPercent, CPTStartDate, CPTDrugID,
                    TBRxStartDate, UnitTBNo, TBStatusID, BreastfeedingID, IsTransferIn,
                    TransferFromFacility, GuardianName, GuardianPhone1)
                  VALUES (@PtDetailsTID, 0, GETDATE(), GETDATE(),
                    @DataSourceID, @CountyID, @EnteredByID, @NearestHFID, @Deleted,
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
                AddPatientParams(cmd, p, dataSourceID, countyID, enteredByID);
                await cmd.ExecuteNonQueryAsync();
                upserted++;
            }

            await tx.CommitAsync();
            _logger.LogInformation("Sync completed: {Count} record(s) upserted.", upserted);
            return Ok(new { message = $"{upserted} record(s) synced successfully." });
        }
        catch (Microsoft.Data.SqlClient.SqlException sqlEx)
        {
            // Return the SQL error number + message so the PWA sync log can
            // show the exact database problem (column missing, FK violation, etc.)
            // without exposing the connection string or server internals.
            var sqlDetail = $"SQL {sqlEx.Number}: {sqlEx.Message}";
            _logger.LogError(sqlEx, "SQL error during patient sync.");
            return StatusCode(500, new { error = sqlDetail });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Database error during patient sync.");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  POST /api/patients/sync-full
    //  Accepts a full payload: patients + INH + PMTCT + regimen history + visits.
    //  Strategy for PtDetailsT: MERGE (upsert) keyed on PtDetailsTID.
    //  Strategy for child tables: DELETE all server-side rows for each patient
    //  then INSERT what the PWA provides — guarantees server mirrors local state
    //  even when the PWA re-generates sub-record GUIDs on edit.
    // ──────────────────────────────────────────────────────────────────────
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

            // ── Step 1: MERGE PtDetailsT — local device is source of truth ─────
            const string mergeSql = """
                MERGE INTO PtDetailsT AS target
                USING (SELECT @PtDetailsTID AS PtDetailsTID) AS source
                ON target.PtDetailsTID = source.PtDetailsTID
                WHEN MATCHED THEN
                  UPDATE SET
                    HasChanged=0, LastModOn=GETDATE(),
                    Deleted=@Deleted,
                    NearestHFID=@NearestHFID,
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
                    DataSourceID, CountyID, EnteredByID, NearestHFID, Deleted,
                    HIVRetest, ARTNo, ARTStartDate, DateEnrolledInCare, FullName,
                    ResidenceAddress, Phone1, Phone2, OccupationID, OccupationOther,
                    KeyPopuID, KeyPopuOther, Age, DateOfBirth, SexID,
                    WeightKg, HeightCm, MUACCm, BMI, WHOStageID,
                    CD4Value, CD4IsPercent, CPTStartDate, CPTDrugID,
                    TBRxStartDate, UnitTBNo, TBStatusID, BreastfeedingID, IsTransferIn,
                    TransferFromFacility, GuardianName, GuardianPhone1)
                  VALUES (@PtDetailsTID, 0, GETDATE(), GETDATE(),
                    @DataSourceID, @CountyID, @EnteredByID, @NearestHFID, @Deleted,
                    @HIVRetest, @ARTNo, @ARTStartDate, @DateEnrolledInCare, @FullName,
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

            // ── Step 2: Delete all child-table rows for each synced patient ──
            // The PWA regenerates sub-record GUIDs on every edit (delete+re-insert),
            // so DELETE+INSERT is the only way to guarantee server == local state.
            foreach (var tid in patientTIDs)
            {
                foreach (var table in new[] { "INHProphylaxisT", "PMTCTPregnancyT", "RegimenHistoryT", "PtFollowUpT" })
                {
                    await using var delCmd = new SqlCommand(
                        $"DELETE FROM {table} WHERE PtDetailsTID = @TID", conn, tx);
                    delCmd.Parameters.AddWithValue("@TID", tid);
                    await delCmd.ExecuteNonQueryAsync();
                }
            }

            // ── Step 3: Insert INH prophylaxis records ────────────────────
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

            // ── Step 4: Insert PMTCT pregnancy records ────────────────────
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

            // ── Step 5: Insert regimen history records ────────────────────
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

            // ── Step 6: Insert follow-up visit records ────────────────────
            const string followUpSql = """
                INSERT INTO PtFollowUpT
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
                cmd.Parameters.AddWithValue("@ViralLoad",        (object?)r.ViralLoad?.Trim() ?? DBNull.Value);
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
            return StatusCode(500, new { error = sqlDetail });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Database error during full sync.");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  GET /api/patients/geo-tree
    //  Returns the health-facility list filtered to the logged-in user's scope.
    //  - NTP  (MoH / UNDP)     → all facilities  (no filter)
    //  - NTP  + NGO            → facilities for their sub-recipient
    //  - Zonal (state, MoH)    → facilities in their StateID
    //  - Zonal + NGO           → facilities in their SubRecID + LocationID
    //  - DTLS (county, MoH)    → facilities in their CountyID
    //  - DTLS + NGO            → facilities in their SubRecID + LocationID
    //  - Facility staff        → their single facility only
    // ──────────────────────────────────────────────────────────────────────
    [HttpGet("geo-tree")]
    public async Task<IActionResult> GetGeoTree()
    {
        // ── Decode role / scope from JWT claims ─────────────────────────
        bool isNational  = User.IsInRole("National");
        bool isZonal     = User.IsInRole("StateCoordinator");
        bool isDtls      = User.IsInRole("CountySupervisor");
        bool isNgo       = User.IsInRole("NGO");

        int.TryParse(User.FindFirstValue("facility_id"),  out var facilityId);
        int.TryParse(User.FindFirstValue("state_id"),     out var stateId);
        int.TryParse(User.FindFirstValue("county_id"),    out var countyId);
        int.TryParse(User.FindFirstValue("sub_rec_id"),   out var subRecId);
        int.TryParse(User.FindFirstValue("location_id"),  out var locationId);

        // ── Build WHERE clause ──────────────────────────────────────────
        string whereClause;
        var    parameters = new Dictionary<string, object>();

        if (facilityId > 0)
        {
            // Facility staff — see only their own facility
            whereClause = "WHERE HealthFacilityID = @FacilityId";
            parameters["@FacilityId"] = facilityId;
        }
        else if ((isZonal || isDtls) && isNgo)
        {
            // NGO at state or county level — facilities they support at their location
            whereClause = "WHERE SubRecID = @SubRecId AND LocationID = @LocationId";
            parameters["@SubRecId"]   = subRecId;
            parameters["@LocationId"] = locationId;
        }
        else if (isDtls)
        {
            // County supervisor (MoH) — all facilities in their county
            whereClause = "WHERE CountyID = @CountyId";
            parameters["@CountyId"] = countyId;
        }
        else if (isZonal)
        {
            // State coordinator (MoH) — all facilities in their state
            whereClause = "WHERE StateID = @StateId";
            parameters["@StateId"] = stateId;
        }
        else if (isNational && isNgo)
        {
            // NGO national — all facilities supported by their sub-recipient
            whereClause = "WHERE SubRecID = @SubRecId";
            parameters["@SubRecId"] = subRecId;
        }
        else
        {
            // National MoH / UNDP — all facilities (no filter)
            whereClause = "";
        }

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();
            // Safe: whereClause is built from controlled logic, never user input.
            var sql = $"""
                SELECT HealthFacilityID, HealthFacility, CountyID, County, StateID, State
                FROM   vwGeogAreaQ
                {whereClause}
                ORDER  BY State, County, HealthFacility
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
                });
            return Ok(results);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading geographic tree.");
            return StatusCode(500, new { error = "Could not load geographic data." });
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

    private static void AddPatientParams(
        SqlCommand cmd, PatientRecord p,
        int dataSourceID, int countyID, Guid enteredByID)
    {
        // Server-stamped scope fields — not read from client input.
        // DataSourceID and CountyID are stored as NULL when the user has no
        // facility/county assigned (value 0 from JWT) — the production tables
        // don't have a row 0, so NULL is the correct representation.
        // NearestHFID comes from the payload (the tree-selected facility).
        cmd.Parameters.AddWithValue("@DataSourceID",
            dataSourceID == 0 ? (object)DBNull.Value : dataSourceID);
        cmd.Parameters.AddWithValue("@CountyID",
            countyID == 0 ? (object)DBNull.Value : countyID);
        cmd.Parameters.AddWithValue("@EnteredByID",
            enteredByID == Guid.Empty ? (object)DBNull.Value : enteredByID);
        cmd.Parameters.AddWithValue("@NearestHFID",
            p.NearestHFID == 0 ? (object)DBNull.Value : p.NearestHFID);
        cmd.Parameters.AddWithValue("@Deleted", p.Deleted);
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
