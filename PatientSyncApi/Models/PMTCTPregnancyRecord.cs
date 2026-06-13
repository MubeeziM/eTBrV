namespace PatientSyncApi.Models;

/// <summary>Represents one PMTCT pregnancy record from the PWA sync payload.</summary>
public sealed class PMTCTPregnancyRecord
{
    public Guid      PMTCTPregnancyTID  { get; set; }
    public Guid      PtDetailsTID       { get; set; }
    public int       PregnancyNo        { get; set; }
    public string?   ANCNo              { get; set; }
    public DateTime? DeliveryDate       { get; set; }
    public int       MotherReceivedART  { get; set; }
    public int       InfantReceivedARVs { get; set; }
    public int       HasChanged         { get; set; } = 1;
}
