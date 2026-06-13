namespace PatientSyncApi.Models;

/// <summary>Represents one regimen history record from the PWA sync payload.</summary>
public sealed class RegimenHistoryRecord
{
    public Guid      RegimenHistoryTID { get; set; }
    public Guid      PtDetailsTID      { get; set; }
    public int       RegimenLine       { get; set; }
    public int       SequenceNo        { get; set; }
    public int       RegimenID         { get; set; }
    public int       ChangeReasonID    { get; set; }
    public string?   OtherReasonText   { get; set; }
    public DateTime? EventDate         { get; set; }
    public int       HasChanged        { get; set; } = 1;
}
