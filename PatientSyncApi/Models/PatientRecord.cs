namespace PatientSyncApi.Models;

/// <summary>
/// Represents a single ART patient record received in the PWA sync payload.
/// Only the fields needed for server-side upsert are included here;
/// child-table records (INH, PMTCT, regimen history, follow-ups) are handled
/// by separate endpoints and models.
/// </summary>
public sealed class PatientRecord
{
    // ── System / sync fields ──────────────────────────────────────────────
    public Guid     PtDetailsTID         { get; set; }
    public int      HasChanged           { get; set; } = 1;

    // ── Registration fields ───────────────────────────────────────────────
    public int      HIVRetest            { get; set; }
    public string   ARTNo                { get; set; } = string.Empty;
    public DateTime? ARTStartDate        { get; set; }
    public DateTime? DateEnrolledInCare  { get; set; }
    public string   FullName             { get; set; } = string.Empty;
    public string?  ResidenceAddress     { get; set; }
    public string?  Phone1               { get; set; }
    public string?  Phone2               { get; set; }
    public int      OccupationID         { get; set; }
    public string?  OccupationOther      { get; set; }
    public int      KeyPopuID            { get; set; }
    public string?  KeyPopuOther         { get; set; }
    public int      Age                  { get; set; }
    public DateTime? DateOfBirth         { get; set; }
    public int      SexID                { get; set; }

    // ── Clinical baseline ─────────────────────────────────────────────────
    public decimal? WeightKg             { get; set; }
    public decimal? HeightCm             { get; set; }
    public decimal? MUACCm               { get; set; }
    public decimal? BMI                  { get; set; }
    public int      WHOStageID           { get; set; }
    public decimal? CD4Value             { get; set; }
    public int      CD4IsPercent         { get; set; }
    public DateTime? CPTStartDate        { get; set; }
    public int      CPTDrugID            { get; set; }
    public DateTime? TBRxStartDate       { get; set; }
    public string?  UnitTBNo             { get; set; }  public int      TBStatusID           { get; set; }    public int      BreastfeedingID      { get; set; }
    public int      IsTransferIn         { get; set; }
    public string?  TransferFromFacility { get; set; }
    public string?  GuardianName         { get; set; }
    public string?  GuardianPhone1       { get; set; }
}
