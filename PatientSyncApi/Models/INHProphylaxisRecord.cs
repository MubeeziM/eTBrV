namespace PatientSyncApi.Models;

/// <summary>Represents one INH prophylaxis record from the PWA sync payload.</summary>
public sealed class INHProphylaxisRecord
{
    public Guid      INHProphylaxisTID { get; set; }
    public Guid      PtDetailsTID      { get; set; }
    public int       SequenceNo        { get; set; }
    public DateTime? INHDate           { get; set; }
    public int       HasChanged        { get; set; } = 1;
}
