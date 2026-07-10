namespace PatientSyncApi.Models;

/// <summary>
/// Full sync payload sent from the PWA — contains PtDetailsARTT plus all child-table records.
/// </summary>
public sealed class FullSyncPayload
{
    public List<PatientRecord>        Patients       { get; set; } = new();
    public List<INHProphylaxisRecord> INHRecords     { get; set; } = new();
    public List<PMTCTPregnancyRecord> PMTCTRecords   { get; set; } = new();
    public List<RegimenHistoryRecord> RegimenHistory { get; set; } = new();
    public List<PtFollowUpRecord>     FollowUps      { get; set; } = new();
}
