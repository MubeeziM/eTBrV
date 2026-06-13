namespace PatientSyncApi.Models;

/// <summary>Represents one follow-up visit record from the PWA sync payload.</summary>
public sealed class PtFollowUpRecord
{
    public Guid      PtFollowUpTID    { get; set; }
    public Guid      PtDetailsTID     { get; set; }
    public DateTime? VisitDate        { get; set; }
    public int       VisitMonth       { get; set; }
    public int       FollowUpStatusID { get; set; }
    public int       RegimenID        { get; set; }
    public int       TBStatusID       { get; set; }
    public int       StopReasonID     { get; set; }
    public string?   StopOtherText    { get; set; }
    public int       WeeksInterrupted { get; set; }
    public decimal?  WeightKg         { get; set; }
    public decimal?  HeightCm         { get; set; }
    public decimal?  BMI              { get; set; }
    public int       CPTDrugID        { get; set; }
    public decimal?  CD4Value         { get; set; }
    public int       CD4IsPercent     { get; set; }
    public string?   ViralLoad        { get; set; }
    public string?   Notes            { get; set; }
    public int       HasChanged       { get; set; } = 1;
}
